// Puente con ISKRA (WhatsApp). La llave vive solo en Vercel (ISKRA_API_KEY); el navegador nunca la ve.
// Un solo número de STRIKD, varias personas: cada conversación tiene dueño.
//  · Head y Creator Partnerships Manager ven todas; el Account Manager solo las suyas (lo filtra el servidor).
//  · Conversación nueva → se asigna sola: opción "load" (menos carga) u opción "best" (mejores resultados, 4 semanas).
//  · Cada envío queda registrado con quién lo mandó. Envíos siempre por clic de una persona, con idempotency_key.
const { withPg, userFromReq } = require("../lib/google");
const BASE = (process.env.ISKRA_API_URL || "https://xglfamaaotmwulglwcui.supabase.co/functions/v1/public-api").replace(/\/$/, "");
const enc = encodeURIComponent;
const digits = x => String(x || "").replace(/\D/g, "").slice(-10);
const arr = j => Array.isArray(j) ? j : (j && (j.data || j.items || j.conversations || j.messages || j.results)) || [];
const convId = c => String(c.id || c.conversation_id || "");
const convPhone = c => { const ct = c.contact || c.lead || {}; return c.phone || c.lead_phone || c.contact_phone || ct.phone || c.wa_id || ""; };

async function iskra(method, path, payload){
  const r = await fetch(BASE + path, {method, headers:{authorization:"Bearer " + process.env.ISKRA_API_KEY, "content-type":"application/json"}, body: payload ? JSON.stringify(payload) : undefined});
  const text = await r.text(); let j; try{ j = JSON.parse(text); }catch(_){ j = {raw:text.slice(0, 2000)}; }
  if (!r.ok) throw Object.assign(new Error((j && (j.error || j.message)) || ("ISKRA " + r.status)), {status:r.status, detail:j});
  return j;
}
const SQL_INIT = `
create table if not exists public.iskra_owner (conversation_id text primary key, phone text, owner uuid, assigned_at timestamptz default now(),
  assigned_by text, escalated_at timestamptz, last_sender uuid, last_sent_at timestamptz);
alter table public.iskra_owner add column if not exists replied_at timestamptz;
alter table public.iskra_owner add column if not exists discarded_at timestamptz;
alter table public.iskra_owner add column if not exists discarded_by uuid;
create table if not exists public.iskra_sent (id bigserial primary key, conversation_id text, user_id uuid, text text, at timestamptz default now());
alter table public.iskra_owner enable row level security; alter table public.iskra_sent enable row level security;`;

// Elige dueño para conversaciones nuevas. Carga todo una sola vez por petición (rápido aunque lleguen muchas juntas).
function makePicker(c, mode){
  let ready = null;
  const load0 = async () => {
    const phones = {};
    (await c.query(`select split_part(path,'/',2) as uid, right(regexp_replace(coalesce(data->>'phone',''),'\\D','','g'),10) as d from public.docs
      where (path like 'meets/%/items/%' or path like 'meets/%/waleads/%') and coalesce(data->>'phone','') <> ''`)).rows.forEach(r => { if (r.d && !phones[r.d]) phones[r.d] = r.uid; });
    const users = (await c.query("select id, role from public.app_users where active")).rows;
    const active = new Set(users.map(u => u.id));
    const ams = users.filter(u => u.role === "am").map(u => u.id);
    const fallback = (users.find(u => u.role === "manager") || users.find(u => u.role === "head") || {}).id || null;
    const load = Object.fromEntries(ams.map(id => [id, 0]));
    if (ams.length) (await c.query("select owner, count(*)::int n from public.iskra_owner where owner = any($1) and replied_at is not null group by owner", [ams])).rows.forEach(x => load[x.owner] = x.n);
    const score = {};
    if (mode === "best" && ams.length) (await c.query(`select split_part(path,'/',2) uid, sum(coalesce((data->>'pts')::numeric,0)) pts from public.docs
      where path like 'points/%/ev/%' and coalesce((data->>'at')::bigint,0) >= $1 group by 1`, [Date.now() - 28*864e5])).rows.forEach(x => score[x.uid] = Number(x.pts));
    return {phones, active, ams, fallback, load, score};
  };
  return async phone => {
    const k = await (ready ||= load0());
    const d = digits(phone), u = d && k.phones[d];
    if (u && k.active.has(u)) return {owner:u, by:"prospecto"};
    if (!k.ams.length) return {owner:k.fallback, by:"sin-am"};
    const am = k.ams.slice().sort((a, b) => mode === "best" ? ((k.score[b]||0) - (k.score[a]||0)) || (k.load[a] - k.load[b]) : (k.load[a] - k.load[b]) || ((k.score[b]||0) - (k.score[a]||0)))[0];
    k.load[am]++;
    return {owner:am, by:mode === "best" ? "mejores-resultados" : "menos-carga"};
  };
}

module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") return res.status(405).json({error:"POST"});
  const me = await userFromReq(req);
  if (!me) return res.status(401).json({error:"Sesión no válida"});
  if (!["head", "manager", "am"].includes(me.role)) return res.status(403).json({error:"Sin acceso a WhatsApp."});
  if (!process.env.ISKRA_API_KEY) return res.json({configured:false});
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const op = body.op, input = body.input || {}, lead = me.role !== "am";
  try{
    const out = await withPg(async c => {
      if (!globalThis.__iskInit){ await c.query(SQL_INIT); globalThis.__iskInit = true; } // solo una vez por arranque
      const ownerOf = async id => (await c.query("select * from public.iskra_owner where conversation_id=$1", [String(id)])).rows[0];
      const mustOwn = async id => { const o = await ownerOf(id); if (!lead && (!o || o.owner !== me.id)) throw Object.assign(new Error("Esta conversación es de otra persona."), {status:403}); return o; };
      if (op === "whoami"){ const j = await iskra("GET", "/v1/whoami"); return {data:j, me:{id:me.id, role:me.role}}; }
      if (op === "conversations"){
        // Solo conversaciones donde el prospecto YA contestó al menos una vez.
        // Fuente 1: mensajes entrantes recientes (GET /v1/messages/whatsapp?direction=inbound), lo más nuevo primero.
        // Fuente 2: la lista de conversaciones. Lo que ya contestó queda marcado (replied_at) para no perderlo.
        const isIn = m => /^(in|inbound|incoming|received|lead)/i.test(String(m.direction || m.dir || m.from_type || (m.from_me===false ? "in" : m.from_me ? "out" : "") || ""));
        const mConv = m => String(m.conversation_id || (m.conversation && m.conversation.id) || m.chat_id || m.thread_id || "");
        const mAt = m => Date.parse(m.created_at || m.sent_at || m.received_at || m.timestamp || "") || 0;
        const mPhone = m => m.phone || m.from || m.lead_phone || m.contact_phone || (m.contact && m.contact.phone) || "";
        const mName = m => m.lead_name || m.contact_name || m.name || (m.contact && m.contact.name) || "";
        const mText = m => String(m.text || m.body || m.content || m.message || "");
        let inbound = [], inErr = null; const T = {}, t0 = Date.now();
        const [inRes, j] = await Promise.all([
          iskra("GET", "/v1/messages/whatsapp?direction=inbound&limit=100").catch(e => { inErr = e.message; return []; }),
          iskra("GET", "/v1/conversations?limit=100")]);
        inbound = arr(inRes).filter(m => isIn(m) || !m.direction); T.iskra = Date.now() - t0;
        const lastIn = {};
        inbound.forEach(m => { const id = mConv(m); if (id && (!lastIn[id] || mAt(m) > mAt(lastIn[id]))) lastIn[id] = m; });
        const list = arr(j), byId = {};
        list.forEach(cv => { const id = convId(cv); if (id) byId[id] = cv; });
        // conversaciones que contestaron pero ya no salen en la primera página de la lista
        Object.entries(lastIn).forEach(([id, m]) => { if (!byId[id]) byId[id] = {id, phone:mPhone(m), lead_name:mName(m), last_message:{text:mText(m), direction:"inbound", created_at:m.created_at || m.sent_at || m.timestamp}}; });
        const ids = Object.keys(byId);
        const known = {};
        (await c.query("select * from public.iskra_owner where conversation_id = any($1)", [ids])).rows.forEach(o => known[o.conversation_id] = o);
        const lmIn = cv => { const lm = cv.last_message; return lm && typeof lm === "object" && isIn(lm); };
        const replied = id => !!(lastIn[id] || (known[id] && known[id].replied_at) || lmIn(byId[id]) || Number(byId[id].inbound_count || byId[id].replies || 0) > 0 || byId[id].last_inbound_at || byId[id].replied_at);
        const cfg = (await c.query("select data from public.docs where path='config/main'")).rows[0];
        const mode = cfg && cfg.data && cfg.data.iskAssign === "best" ? "best" : "load";
        const out = [], pick = makePicker(c, mode); T.prep = Date.now() - t0;
        for (const id of ids){
          if (!replied(id)) continue;
          const cv = byId[id];
          if (lastIn[id]){ // lo más reciente que escribió el prospecto manda sobre una lista vieja
            const li = lastIn[id], lm = cv.last_message || {};
            const lmAt = Date.parse((lm && (lm.created_at || lm.sent_at)) || cv.last_activity_at || cv.updated_at || "") || 0;
            if (mAt(li) >= lmAt) cv.last_message = {text:mText(li), direction:"inbound", created_at:li.created_at || li.sent_at || li.timestamp};
          }
          let o = known[id];
          if (!o){
            const p = await pick(convPhone(cv));
            o = (await c.query(`insert into public.iskra_owner (conversation_id, phone, owner, assigned_by, replied_at) values ($1,$2,$3,$4,now())
              on conflict (conversation_id) do update set replied_at=coalesce(public.iskra_owner.replied_at, now()) returning *`, [id, digits(convPhone(cv)), p.owner, p.by])).rows[0];
          } else if (!o.replied_at){
            await c.query("update public.iskra_owner set replied_at=now() where conversation_id=$1", [id]); o.replied_at = new Date();
            if (!o.owner){ const p = await pick(convPhone(cv)); await c.query("update public.iskra_owner set owner=$2, assigned_by=$3 where conversation_id=$1", [id, p.owner, p.by]); o.owner = p.owner; o.assigned_by = p.by; }
          }
          if (lead || o.owner === me.id) out.push({...cv, _strikd:{owner:o.owner, assignedBy:o.assigned_by, escalatedAt:o.escalated_at, lastSender:o.last_sender, lastSentAt:o.last_sent_at, discardedAt:o.discarded_at, discardedBy:o.discarded_by}});
        }
        T.total = Date.now() - t0; res.setHeader("server-timing", `iskra;dur=${T.iskra}, total;dur=${T.total}`);
        const debug = lead ? {tiempos_ms:T, conversaciones_en_lista:list.length, entrantes_leidos:inbound.length, con_respuesta:out.length, error_entrantes:inErr,
          ejemplo_conversacion:list[0] || null, ejemplo_entrante:inbound[0] || null} : undefined;
        return {data:{data:out}, mode, debug};
      }
      if (op === "messages"){
        if (!input.id) throw Object.assign(new Error("Falta id"), {status:400});
        await mustOwn(input.id);
        const j = await iskra("GET", `/v1/conversations/${enc(input.id)}/messages?limit=${Math.min(Number(input.limit) || 50, 100)}`);
        const sent = (await c.query("select user_id, text, extract(epoch from at)*1000 as at from public.iskra_sent where conversation_id=$1 order by at desc limit 200", [String(input.id)])).rows;
        return {data:j, sent:sent.map(s => ({by:s.user_id, text:s.text, at:Number(s.at)}))};
      }
      if (op === "reply"){
        const media = input.media && input.media.url ? input.media : null;
        if (!input.conversation_id || (!input.text && !media) || !input.idempotency_key) throw Object.assign(new Error("Faltan datos"), {status:400});
        await mustOwn(input.conversation_id);
        const text = String(input.text || "").slice(0, 4000);
        const payload = {conversation_id:input.conversation_id, idempotency_key:input.idempotency_key};
        if (text) payload.text = text;
        if (media){ // foto, PDF o nota de voz: ISKRA la descarga del link público
          const kind = /^image\//.test(media.type) ? "image" : /^audio\//.test(media.type) ? "audio" : "document";
          Object.assign(payload, {type:kind, media_url:media.url, media_type:media.type, filename:media.name || undefined});
          if (text) payload.caption = text;
        }
        const j = await iskra("POST", "/v1/messages/reply", payload);
        const label = media ? `${text ? text + " " : ""}[${media.type && media.type.startsWith("audio/") ? "nota de voz" : media.name || "archivo"}]` : text;
        await c.query("insert into public.iskra_sent (conversation_id, user_id, text) values ($1,$2,$3)", [String(input.conversation_id), me.id, label]);
        await c.query("update public.iskra_owner set last_sender=$2, last_sent_at=now() where conversation_id=$1", [String(input.conversation_id), me.id]);
        return {data:j};
      }
      if (op === "discard"){ // descartar (o regresar) una conversación: deja de salir en la bandeja
        await mustOwn(input.id);
        await c.query(input.undo ? "update public.iskra_owner set discarded_at=null, discarded_by=null where conversation_id=$1"
          : "update public.iskra_owner set discarded_at=now(), discarded_by=$2 where conversation_id=$1", input.undo ? [String(input.id)] : [String(input.id), me.id]);
        return {ok:true};
      }
      if (op === "assign"){
        if (!lead) throw Object.assign(new Error("Solo el Head o el Manager reasignan."), {status:403});
        await c.query(`insert into public.iskra_owner (conversation_id, owner, assigned_by) values ($1,$2,'manual')
          on conflict (conversation_id) do update set owner=excluded.owner, assigned_by='manual', assigned_at=now(), escalated_at=null`, [String(input.id), input.owner || null]);
        return {ok:true};
      }
      if (op === "escalate"){
        await mustOwn(input.id);
        const m = (await c.query("select id from public.app_users where role='manager' and active limit 1")).rows[0]
          || (await c.query("select id from public.app_users where role='head' and active limit 1")).rows[0];
        await c.query("update public.iskra_owner set owner=$2, escalated_at=now(), assigned_by='escalado' where conversation_id=$1", [String(input.id), m ? m.id : null]);
        return {ok:true};
      }
      if (op === "stats"){
        if (!lead) throw Object.assign(new Error("Solo el Head o el Manager ven los resultados."), {status:403});
        const q = new URLSearchParams(); ["from","to","period"].forEach(k => { if (input[k]) q.set(k, String(input[k])); });
        const [sum, acc] = await Promise.all([iskra("GET", "/v1/stats/summary" + (q.toString() ? "?" + q : "")), iskra("GET", "/v1/campaigns/accounting" + (q.toString() ? "?" + q : "")).catch(e => ({error:e.message}))]);
        return {data:{summary:sum, campaigns:acc}};
      }
      if (op === "numbers") return {data:await iskra("GET", "/v1/numbers")};
      if (op === "templates") return {data:await iskra("GET", "/v1/templates")};
      throw Object.assign(new Error("Operación no permitida"), {status:400});
    });
    res.json({configured:true, ...out});
  }catch(err){ res.status(err.status || 502).json({configured:true, error:String(err.message || err), detail:err.detail}); }
};
