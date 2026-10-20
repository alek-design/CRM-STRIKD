// Tiempo de respuesta en WhatsApp (ISKRA), por persona.
// Cada minuto (push-check) se leen los mensajes recientes de entrada y salida:
//  - Llega un mensaje del prospecto y la conversación estaba contestada → empieza "esperando desde".
//  - Sale una respuesta del equipo → se cierra la espera y se guarda cuánto tardó (solo cuenta horario laboral).
// A quién se le cuenta: a quien contestó desde el panel; si contestaron directo en ISKRA, al dueño de la conversación.
const OFF = 5 * 3600e3, H0 = 8, H1 = 20; // horario laboral 8 am – 8 pm (Cancún)

async function ensure(c){
  await c.query(`create table if not exists public.iskra_wait (conversation_id text primary key, since timestamptz, last_seen timestamptz);
    alter table public.iskra_wait enable row level security;
    create table if not exists public.iskra_resp (conversation_id text, in_at timestamptz, out_at timestamptz, owner uuid, responder uuid, ms bigint,
      created_at timestamptz default now(), primary key (conversation_id, in_at));
    alter table public.iskra_resp enable row level security;`);
}
// milisegundos dentro del horario laboral entre a y b
function bizMs(a, b){
  if (!(b > a)) return 0;
  let t = a, total = 0;
  while (t < b){
    const l = new Date(t - OFF), dayStart = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()) + OFF;
    const s = dayStart + H0 * 3600e3, e = dayStart + H1 * 3600e3;
    total += Math.max(0, Math.min(b, e) - Math.max(t, s));
    t = dayStart + 24 * 3600e3;
  }
  return total;
}
const arr = j => Array.isArray(j) ? j : (j && (j.data || j.items || j.messages || j.results)) || [];
const atOf = m => Date.parse(m.created_at || m.sent_at || m.timestamp || "") || 0;

async function run(c, get){
  await ensure(c);
  const since = new Date(Date.now() - 30 * 60e3).toISOString(), q = `limit=100&from=${encodeURIComponent(since)}&since=${encodeURIComponent(since)}`;
  const [ins, outs] = await Promise.all([
    get(`/v1/messages/whatsapp?direction=inbound&${q}`, 5000).then(arr).catch(() => null),
    get(`/v1/messages/whatsapp?direction=outbound&${q}`, 5000).then(arr).catch(() => null)]);
  if (!ins || !outs) return {error:"no se pudieron leer los mensajes"};
  const ev = {};
  ins.forEach(m => { const id = String(m.conversation_id || ""), t = atOf(m); if (id && t) (ev[id] ||= []).push({t, d:"in"}); });
  outs.forEach(m => { const id = String(m.conversation_id || ""), t = atOf(m); if (id && t) (ev[id] ||= []).push({t, d:"out"}); });
  const ids = Object.keys(ev); if (!ids.length) return null;
  const wait = {}; (await c.query("select * from public.iskra_wait where conversation_id = any($1)", [ids])).rows.forEach(r => wait[r.conversation_id] = r);
  const own = {}; (await c.query("select conversation_id, owner, last_sender, last_sent_at, discarded_at from public.iskra_owner where conversation_id = any($1)", [ids]).catch(() => ({rows:[]}))).rows.forEach(r => own[r.conversation_id] = r);
  const autoAt = {}; (await c.query("select conversation_id, sent_at from public.iskra_auto where conversation_id = any($1)", [ids]).catch(() => ({rows:[]}))).rows.forEach(r => autoAt[r.conversation_id] = r.sent_at ? new Date(r.sent_at).getTime() : 0);
  let saved = 0;
  for (const id of ids){
    const w = wait[id] || {}, o = own[id] || {};
    let sinceT = w.since ? new Date(w.since).getTime() : 0, seen = w.last_seen ? new Date(w.last_seen).getTime() : 0;
    const list = ev[id].filter(e => e.t > seen).sort((a, b) => a.t - b.t || (a.d === "in" ? -1 : 1));
    if (!list.length) continue;
    for (const e of list){
      if (e.d === "in"){ if (!sinceT) sinceT = e.t; }
      else if (sinceT){
        const isAuto = autoAt[id] && Math.abs(e.t - autoAt[id]) < 3 * 60e3; // la plantilla automática no cuenta como respuesta de una persona
        const discarded = o.discarded_at && new Date(o.discarded_at).getTime() <= e.t;
        if (!isAuto && !discarded){
          const ls = o.last_sent_at ? new Date(o.last_sent_at).getTime() : 0;
          const responder = o.last_sender && Math.abs(ls - e.t) < 3 * 60e3 ? o.last_sender : (o.owner || null);
          await c.query(`insert into public.iskra_resp (conversation_id, in_at, out_at, owner, responder, ms) values ($1, to_timestamp($2/1000.0), to_timestamp($3/1000.0), $4, $5, $6)
            on conflict (conversation_id, in_at) do nothing`, [id, sinceT, e.t, o.owner || null, responder, bizMs(sinceT, e.t)]);
          saved++;
        }
        sinceT = 0;
      }
      seen = Math.max(seen, e.t);
    }
    await c.query(`insert into public.iskra_wait (conversation_id, since, last_seen) values ($1, $2, to_timestamp($3/1000.0))
      on conflict (conversation_id) do update set since=excluded.since, last_seen=excluded.last_seen`, [id, sinceT ? new Date(sinceT).toISOString() : null, seen]);
  }
  return saved ? {respuestas:saved} : null;
}
const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
// por persona: mediana, % en menos de 15 min, cuántas tardaron más de 1 h y cuántas tiene esperando ahora
async function stats(c, from, to){
  await ensure(c);
  const rows = (await c.query("select coalesce(responder, owner) u, ms from public.iskra_resp where out_at >= to_timestamp($1/1000.0) and out_at < to_timestamp($2/1000.0)", [from, to])).rows;
  const by = {}; rows.forEach(r => { if (r.u) (by[r.u] ||= []).push(Number(r.ms)); });
  const all = rows.map(r => Number(r.ms));
  const waiting = (await c.query(`select o.owner u, w.since from public.iskra_wait w join public.iskra_owner o using (conversation_id)
    where w.since is not null and o.discarded_at is null`).catch(() => ({rows:[]}))).rows;
  const wBy = {}; waiting.forEach(r => { if (r.u) (wBy[r.u] ||= []).push(bizMs(new Date(r.since).getTime(), Date.now())); });
  const pack = l => ({n:l.length, med:median(l), fast:l.length ? Math.round(l.filter(x => x < 15 * 60e3).length / l.length * 100) : null, slow:l.filter(x => x > 60 * 60e3).length});
  const people = {}; new Set([...Object.keys(by), ...Object.keys(wBy)]).forEach(u => people[u] = {...pack(by[u] || []), waiting:(wBy[u] || []).length, waitingLong:(wBy[u] || []).filter(x => x > 60 * 60e3).length});
  return {from, to, team:pack(all), people};
}
async function waitMap(c, ids){
  await ensure(c);
  const out = {}; (await c.query("select conversation_id, since from public.iskra_wait where conversation_id = any($1) and since is not null", [ids])).rows.forEach(r => out[r.conversation_id] = new Date(r.since).getTime());
  return out;
}
module.exports = {run, stats, waitMap, bizMs};
