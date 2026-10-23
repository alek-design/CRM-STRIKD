// Seguimiento automático "Dejó de responder" (aprobado por Alek, 22 oct 2026).
// A quién: chats marcados 🔥 Interés, donde el prospecto ya mandó al menos 2 mensajes, lo último lo mandamos nosotros
// y pasaron 2 h sin respuesta. Solo se manda de 9 am a 9 pm (hora de Cancún); si las 2 h se cumplen fuera de ese horario,
// sale al día siguiente a partir de las 9 am. Una sola vez por cada silencio (si vuelve a escribir y otra vez se calla, puede volver a salir).
// Plantilla: la que se llame "Dejó de responder" en Mensajes → Plantillas. Apagado/encendido: config/main.stallAuto (encendido por defecto).
const { publicMedia, withLink } = require("./iskmedia");
const iskapp = require("./iskapp");

const OFF = 5 * 3600e3, WAIT = 2 * 3600e3, H_FROM = 9, H_TO = 21, MAX_FETCH = 8;
const fold = v => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const arr = j => Array.isArray(j) ? j : (j && (j.data || j.items || j.messages || j.results)) || [];
const atOf = m => Date.parse(m.created_at || m.sent_at || m.timestamp || "") || 0;
const dirOf = m => /^(in|inbound|incoming|received|lead)/i.test(String(m.direction || m.dir || (m.from_me === false ? "in" : m.from_me ? "out" : "") || "")) ? "in" : "out";
const first = n => String(n || "").trim().split(/\s+/)[0] || "";
const hourCancun = t => new Date(t - OFF).getUTCHours();

async function ensure(c){
  await c.query(`create table if not exists public.iskra_stall (conversation_id text, last_in_at timestamptz, sent_at timestamptz default now(), text text, error text,
    primary key (conversation_id, last_in_at))`);
  await c.query("alter table public.iskra_stall enable row level security").catch(() => {});
  await c.query("create table if not exists public.iskra_stall_chk (conversation_id text primary key, checked_at timestamptz)");
  await c.query("alter table public.iskra_stall_chk enable row level security").catch(() => {});
}
async function template(c){
  const rows = (await c.query("select id, data from public.docs where parent='waTemplates'")).rows;
  const t = rows.find(r => r.data && r.data.active !== false && !r.data.deleted && /dej[oó] de responder/.test(fold(r.data.name)));
  if (!t) return null;
  const vs = Object.entries(t.data.variants || {}).filter(([, v]) => v && String(v.text || "").trim());
  return vs.length ? {id:t.id, name:t.data.name, variants:vs} : null;
}

async function run(c, {get, post, origin, names}){
  const cfg = ((await c.query("select data from public.docs where path='config/main'")).rows[0] || {}).data || {};
  if (cfg.stallAuto === false) return null;
  const now = Date.now(), h = hourCancun(now);
  if (h < H_FROM || h >= H_TO) return null;                     // fuera de horario: espera a mañana
  const tpl = await template(c); if (!tpl) return null;
  await ensure(c);
  // candidatos: chats 🔥 no descartados; se revisan por turnos (los que hace más que no se revisan primero) para no gastar lecturas de ISKRA
  const cand = (await c.query(`select o.conversation_id id from public.iskra_owner o left join public.iskra_stall_chk k using (conversation_id)
    where o.interest_at is not null and o.discarded_at is null and (k.checked_at is null or k.checked_at < now() - interval '4 minutes')
    order by k.checked_at nulls first limit $1`, [MAX_FETCH]).catch(() => ({rows:[]}))).rows.map(r => r.id);
  const out = []; let fetched = 0;
  for (const id of cand){
    if (fetched >= MAX_FETCH) break;
    await c.query("insert into public.iskra_stall_chk (conversation_id, checked_at) values ($1, now()) on conflict (conversation_id) do update set checked_at=now()", [id]).catch(() => {});
    let msgs; try{ msgs = arr(await get(`/v1/conversations/${encodeURIComponent(id)}/messages?limit=50`, 6000)).filter(atOf).sort((a, b) => atOf(a) - atOf(b)); fetched++; }catch(_){ continue; }
    if (!msgs.length) continue;
    const ins = msgs.filter(m => dirOf(m) === "in"), last = msgs[msgs.length - 1], lastIn = ins[ins.length - 1];
    if (ins.length < 2 || !lastIn || dirOf(last) !== "out" || now - atOf(last) < WAIT) continue;
    const lastInAt = new Date(atOf(lastIn));
    if ((await c.query("select 1 from public.iskra_stall where conversation_id=$1 and last_in_at=$2", [id, lastInAt])).rows[0]) continue; // ya se mandó en este silencio
    // si ya le mandamos esta misma plantilla después de su último mensaje, no se repite
    const head = fold(String(tpl.variants[0][1].text).replace(/\{nombre\}/gi, "")).slice(10, 50);
    if (head.length > 15 && msgs.some(m => dirOf(m) === "out" && atOf(m) > atOf(lastIn) && fold(m.text || m.body || "").includes(head))) continue;
    const reserve = await c.query("insert into public.iskra_stall (conversation_id, last_in_at) values ($1,$2) on conflict do nothing returning 1", [id, lastInAt]);
    if (!reserve.rows[0]) continue;
    const counts = {}; (await c.query("select text from public.iskra_stall where text is not null").catch(() => ({rows:[]}))).rows.forEach(r => { const k = tpl.variants.find(([, v]) => r.text && r.text.startsWith(String(v.text).slice(0, 20)))?.[0]; if (k) counts[k] = (counts[k] || 0) + 1; });
    const [vk, v] = tpl.variants.slice().sort((a, b) => (counts[a[0]] || 0) - (counts[b[0]] || 0))[0];
    const text = String(v.text).replace(/\{nombre\}/gi, first((names && names[id]) || lastIn.contact_name || "")).replace(/\s+,/g, ",").trim();
    try{
      const within24 = now - atOf(lastIn) < 23.5 * 3600e3;
      const base = {conversation_id:id, idempotency_key:"stall-" + id + "-" + lastInAt.getTime()};
      if (!within24){
        // fuera de la ventana de 24 h de WhatsApp: solo con plantilla aprobada de ISKRA conectada
        if (!v.iskTplId || !iskapp.configured()) throw new Error("pasaron más de 24 h desde su último mensaje y la plantilla no tiene plantilla aprobada de ISKRA");
        await iskapp.sendTemplate({conversation_id:id, template_group_id:v.iskTplId, variables:{"1":text.replace(/\s*\n+\s*/g, " ")}});
      } else if (v.fileId && iskapp.configured()){
        const pm = await publicMedia({url:"/_blob/" + v.fileId, name:v.fileName || "STRIKD.pdf"}), cap = text.length <= 1024 ? text : "";
        try{ await iskapp.sendMedia({conversation_id:id, text:cap, media:{...pm, name:v.fileName || "STRIKD.pdf"}}); if (!cap) await post("/v1/messages/reply", {...base, text}); }
        catch(_){ await post("/v1/messages/reply", {...base, text:withLink(text, pm, origin)}); }
      } else await post("/v1/messages/reply", {...base, text});
      await c.query("update public.iskra_stall set text=$3 where conversation_id=$1 and last_in_at=$2", [id, lastInAt, text]);
      await c.query("insert into public.iskra_sent (conversation_id, user_id, text) values ($1,null,$2)", [id, "🔁 " + text]).catch(() => {});
      out.push({conv:id, variant:vk});
    }catch(e){
      await c.query("update public.iskra_stall set error=$3 where conversation_id=$1 and last_in_at=$2", [id, lastInAt, String(e.message || e).slice(0, 300)]).catch(() => {});
      out.push({conv:id, error:String(e.message || e)});
    }
  }
  return out.length ? out : null;
}
// para Plantillas: cuántos se han mandado (30 días) y si está activo
async function summary(c){
  try{ await ensure(c); }catch(_){}
  const cfg = ((await c.query("select data from public.docs where path='config/main'")).rows[0] || {}).data || {};
  const r = (await c.query("select count(*) filter (where text is not null)::int sent, count(*) filter (where error is not null)::int err from public.iskra_stall where sent_at > now() - interval '30 days'").catch(() => ({rows:[{}]}))).rows[0] || {};
  return {on:cfg.stallAuto !== false, hasTpl:!!(await template(c)), sent:r.sent || 0, err:r.err || 0};
}
module.exports = {run, summary};
