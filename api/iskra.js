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
create table if not exists public.iskra_sent (id bigserial primary key, conversation_id text, user_id uuid, text text, at timestamptz default now());
alter table public.iskra_owner enable row level security; alter table public.iskra_sent enable row level security;`;

async function pickOwner(c, phone, mode){
  // 1) ¿el teléfono ya es de un prospecto del tablero? → quien lo lleva
  const d = digits(phone);
  if (d){
    const r = await c.query(`select split_part(path,'/',2) as uid from public.docs
      where (path like 'meets/%/items/%' or path like 'meets/%/waleads/%') and right(regexp_replace(coalesce(data->>'phone',''),'\\D','','g'),10) = $1 limit 1`, [d]);
    if (r.rows[0]){ const u = await c.query("select id from public.app_users where id::text=$1 and active", [r.rows[0].uid]); if (u.rows[0]) return {owner:u.rows[0].id, by:"prospecto"}; }
  }
  // 2) Account Manager activo según la opción elegida
  const ams = (await c.query("select id from public.app_users where role='am' and active")).rows.map(x => x.id);
  if (!ams.length){ const m = (await c.query("select id from public.app_users where role in ('manager','head') and active order by role='head'")).rows[0]; return {owner:m ? m.id : null, by:"sin-am"}; }
  const load = Object.fromEntries(ams.map(id => [id, 0]));
  (await c.query("select owner, count(*)::int n from public.iskra_owner where owner = any($1) group by owner", [ams])).rows.forEach(x => load[x.owner] = x.n);
  let score = {};
  if (mode === "best"){
    const since = Date.now() - 28*864e5;
    (await c.query(`select split_part(path,'/',2) uid, sum(coalesce((data->>'pts')::numeric,0)) pts from public.docs
      where path like 'points/%/ev/%' and coalesce((data->>'at')::bigint,0) >= $1 group by 1`, [since])).rows.forEach(x => score[x.uid] = Number(x.pts));
  }
  ams.sort((a, b) => mode === "best" ? ((score[b]||0) - (score[a]||0)) || (load[a] - load[b]) : (load[a] - load[b]) || ((score[b]||0) - (score[a]||0)));
  return {owner:ams[0], by:mode === "best" ? "mejores-resultados" : "menos-carga"};
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
      await c.query(SQL_INIT);
      const ownerOf = async id => (await c.query("select * from public.iskra_owner where conversation_id=$1", [String(id)])).rows[0];
      const mustOwn = async id => { const o = await ownerOf(id); if (!lead && (!o || o.owner !== me.id)) throw Object.assign(new Error("Esta conversación es de otra persona."), {status:403}); return o; };
      if (op === "whoami"){ const j = await iskra("GET", "/v1/whoami"); return {data:j, me:{id:me.id, role:me.role}}; }
      if (op === "conversations"){
        const j = await iskra("GET", "/v1/conversations?limit=" + Math.min(Number(input.limit) || 50, 100));
        const cfg = (await c.query("select data from public.docs where path='config/main'")).rows[0];
        const mode = cfg && cfg.data && cfg.data.iskAssign === "best" ? "best" : "load";
        const list = arr(j), owners = {};
        (await c.query("select * from public.iskra_owner where conversation_id = any($1)", [list.map(convId)])).rows.forEach(o => owners[o.conversation_id] = o);
        for (const cv of list){
          const id = convId(cv); if (!id || owners[id]) continue;
          const p = await pickOwner(c, convPhone(cv), mode);
          const r = await c.query(`insert into public.iskra_owner (conversation_id, phone, owner, assigned_by) values ($1,$2,$3,$4)
            on conflict (conversation_id) do nothing returning *`, [id, digits(convPhone(cv)), p.owner, p.by]);
          owners[id] = r.rows[0] || await ownerOf(id);
        }
        const meta = o => o ? {owner:o.owner, assignedBy:o.assigned_by, escalatedAt:o.escalated_at, lastSender:o.last_sender, lastSentAt:o.last_sent_at} : {};
        const mine = list.filter(cv => lead || (owners[convId(cv)] && owners[convId(cv)].owner === me.id)).map(cv => ({...cv, _strikd:meta(owners[convId(cv)])}));
        return {data:{data:mine}, mode};
      }
      if (op === "messages"){
        if (!input.id) throw Object.assign(new Error("Falta id"), {status:400});
        await mustOwn(input.id);
        const j = await iskra("GET", `/v1/conversations/${enc(input.id)}/messages?limit=${Math.min(Number(input.limit) || 50, 100)}`);
        const sent = (await c.query("select user_id, text, extract(epoch from at)*1000 as at from public.iskra_sent where conversation_id=$1 order by at desc limit 200", [String(input.id)])).rows;
        return {data:j, sent:sent.map(s => ({by:s.user_id, text:s.text, at:Number(s.at)}))};
      }
      if (op === "reply"){
        if (!input.conversation_id || !input.text || !input.idempotency_key) throw Object.assign(new Error("Faltan datos"), {status:400});
        await mustOwn(input.conversation_id);
        const j = await iskra("POST", "/v1/messages/reply", {conversation_id:input.conversation_id, text:String(input.text).slice(0, 4000), idempotency_key:input.idempotency_key});
        await c.query("insert into public.iskra_sent (conversation_id, user_id, text) values ($1,$2,$3)", [String(input.conversation_id), me.id, String(input.text).slice(0, 4000)]);
        await c.query("update public.iskra_owner set last_sender=$2, last_sent_at=now() where conversation_id=$1", [String(input.conversation_id), me.id]);
        return {data:j};
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
      if (op === "numbers") return {data:await iskra("GET", "/v1/numbers")};
      if (op === "templates") return {data:await iskra("GET", "/v1/templates")};
      throw Object.assign(new Error("Operación no permitida"), {status:400});
    });
    res.json({configured:true, ...out});
  }catch(err){ res.status(err.status || 502).json({configured:true, error:String(err.message || err), detail:err.detail}); }
};
