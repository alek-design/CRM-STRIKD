// Segundo intento automático por WhatsApp (prueba A/B/C).
// Cuándo: mandamos el primer mensaje y la "respuesta" llega en ≤ 90 s → es la respuesta automática de su WhatsApp Business,
// no una persona. En ese momento mandamos, solo, la plantilla marcada como "Mandar sola al detectar respuesta automática",
// alternando sus variantes A/B/C (a la que lleve menos envíos). Una sola vez por conversación.
// Cada envío queda en meets/<dueño>/tpllog/auto-<conv> para que Plantillas mida cuál contesta más.
const AUTO_SEC = 90;
const { publicMedia, mediaPayload, asAttachment, withLink, shapes } = require("./iskmedia");
const iskapp = require("./iskapp");

const arr = j => Array.isArray(j) ? j : (j && (j.data || j.items || j.messages || j.results)) || [];
const atOf = m => Date.parse(m.created_at || m.sent_at || m.timestamp || "") || 0;
const dirOf = m => String(m.direction || m.dir || (m.from_me || m.fromMe ? "outbound" : "")).toLowerCase().startsWith("out") ? "out" : "in";
const first = n => String(n || "").trim().split(/\s+/)[0] || "";

async function ensure(c){
  await c.query(`create table if not exists public.iskra_auto (conversation_id text primary key, tpl text, variant text, owner uuid,
    sent_at timestamptz default now(), replied_at timestamptz, text text, error text)`);
}

async function autoTemplate(c){
  const rows = (await c.query("select id, data from public.docs where parent='waTemplates'")).rows;
  const t = rows.find(r => r.data && r.data.autoSend && r.data.active !== false && r.data.trigger === "auto");
  if (!t) return null;
  const vs = Object.entries(t.data.variants || {}).filter(([, v]) => v && String(v.text || "").trim() && v.on !== false);
  return vs.length ? {id:t.id, variants:vs} : null;
}

// Cuando entra un mensaje nuevo de una conversación a la que ya le mandamos el automático, cuenta como "contestó"
async function markReplied(c, id, inboundAt){
  const r = (await c.query("update public.iskra_auto set replied_at=$2 where conversation_id=$1 and replied_at is null and sent_at + interval '90 seconds' < $2 returning owner",
    [id, new Date(inboundAt)])).rows[0];
  if (r && r.owner) await c.query(`update public.docs set data = data || jsonb_build_object('repliedAt', $2::bigint), updated_at=now(), version=version+1 where path=$1`,
    [`meets/${r.owner}/tpllog/auto-${id}`, inboundAt]).catch(() => {});
}

// cv: conversación de ISKRA con mensaje nuevo; get/post: llamadas a ISKRA; owner: dueño (o Head)
async function maybeAuto(c, cv, {get, post, owner, origin}){
  const id = String(cv.id);
  if ((await c.query("select 1 from public.iskra_auto where conversation_id=$1", [id])).rows[0]) return null;
  const tpl = await autoTemplate(c); if (!tpl) return null;
  const msgs = arr(await get(`/v1/conversations/${encodeURIComponent(id)}/messages?limit=50`, 6000)).filter(atOf).sort((a, b) => atOf(a) - atOf(b));
  if (!msgs.length || dirOf(msgs[0]) !== "out") return null;                 // nuestro mensaje fue el primero
  const o1 = atOf(msgs[0]), i1m = msgs.find(m => dirOf(m) === "in"); if (!i1m) return null;
  const i1 = atOf(i1m);
  if (i1 - o1 > AUTO_SEC * 1000 || i1 < o1) return null;                      // contestó en menos de 90 s → automático
  if (Date.now() - i1 > 20 * 60e3) return null;                               // solo lo reciente (no conversaciones viejas)
  const outAfter = msgs.some(m => dirOf(m) === "out" && atOf(m) > i1);
  if (outAfter) return null;                                                  // alguien ya le contestó
  // variante con menos envíos
  const counts = {}; (await c.query("select variant, count(*)::int n from public.iskra_auto where tpl=$1 group by variant", [tpl.id])).rows.forEach(r => counts[r.variant] = r.n);
  const pick = tpl.variants.slice().sort((a, b) => (counts[a[0]] || 0) - (counts[b[0]] || 0) || Math.random() - .5)[0];
  const [vk, v] = pick;
  const name = (cv.lead && cv.lead.full_name) || cv.contact_name || "";
  const text = String(v.text).replace(/\{nombre\}/gi, first(name)).replace(/\s+,/g, ",").trim();
  // reservar antes de mandar: aunque el cron corra dos veces, sale una sola vez
  const ins = await c.query("insert into public.iskra_auto (conversation_id, tpl, variant, owner, text) values ($1,$2,$3,$4,$5) on conflict do nothing returning 1", [id, tpl.id, vk, owner || null, text]);
  if (!ins.rows[0]) return null;
  try{
    const base = {conversation_id:id, idempotency_key:"auto-" + id};
    let sentMedia = false;
    const shapeN = 0;
    if (v.iskTplId){ // plantilla aprobada de ISKRA (con su archivo)
      try{ await post("/v1/messages/reply", {...base, template_id:String(v.iskTplId)}); sentMedia = true; }catch(e){ /* si falla, va el texto */ }
    } else if (v.fileId && iskapp.configured()){ // archivo real (PDF/foto) con el texto de pie, igual que desde el chat
      try{ const pm = await publicMedia({url:"/_blob/" + v.fileId, name:v.fileName || "STRIKD.pdf"});
        const cap = text.length <= 1024 ? text : "";
        await iskapp.sendMedia({conversation_id:id, text:cap, media:{...pm, name:v.fileName || "STRIKD.pdf"}});
        if (!cap) await post("/v1/messages/reply", {...base, idempotency_key:base.idempotency_key + "-t", text});
        sentMedia = true; }
      catch(e){ /* si el archivo falla, va el texto con el link (abajo) */
        try{ const pm = await publicMedia({url:"/_blob/" + v.fileId, name:v.fileName || "STRIKD.pdf"}); await post("/v1/messages/reply", {...base, text:withLink(text, pm, origin)}); sentMedia = true; }catch(_){} }
    } else if (v.fileId && shapeN){
      try{ const pm = await publicMedia({url:"/_blob/" + v.fileId, name:v.fileName || "STRIKD.pdf"}); await post("/v1/messages/reply", {...base, ...shapes(pm, text, shapeN)}); sentMedia = true; }
      catch(e){ /* si el archivo falla, va solo el texto */ }
    } else if (v.fileId && !asAttachment()){
      try{ const pm = await publicMedia({url:"/_blob/" + v.fileId, name:v.fileName || "STRIKD.pdf"}); await post("/v1/messages/reply", {...base, text:withLink(text, pm, origin)}); sentMedia = true; }
      catch(e){ /* si el archivo falla, va solo el texto */ }
    } else if (v.fileId){
      try{ const pm = await publicMedia({url:"/_blob/" + v.fileId, name:v.fileName || "STRIKD.pdf"}); await post("/v1/messages/reply", {...base, ...mediaPayload(pm, text)}); sentMedia = true; }
      catch(e){ /* si el archivo no pasa, va solo el texto */ }
    }
    if (!sentMedia) await post("/v1/messages/reply", {...base, idempotency_key:base.idempotency_key + "-t", text});
    await c.query("insert into public.iskra_sent (conversation_id, user_id, text) values ($1,null,$2)", [id, "🤖 " + text]).catch(() => {});
    if (owner) await c.query("insert into public.docs (path, data) values ($1,$2) on conflict (path) do nothing",
      [`meets/${owner}/tpllog/auto-${id}`, {tpl:tpl.id, v:vk, at:Date.now(), conv:id, auto:true}]);
    return {conv:id, variant:vk};
  }catch(e){
    await c.query("update public.iskra_auto set error=$2 where conversation_id=$1", [id, String(e.message || e).slice(0, 300)]);
    return {conv:id, error:String(e.message || e)};
  }
}

module.exports = {ensure, maybeAuto, markReplied, AUTO_SEC};
