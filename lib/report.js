// Reporte diario: a las 9:00 pm (Cancún) le llega al Head (todo el equipo) y a cada Manager (sus AMs) una notificación
// con los números del día. Al tocarla abre "Reporte del día" en la app, que trae el detalle completo.
// Lo llama push-check (cada minuto); se manda una sola vez por día y por persona.
const { sendTo } = require("./push");
const OFF = 5 * 3600e3, DAY = 864e5, HOUR = 21;

async function ensure(c){
  await c.query("create table if not exists public.report_sent (day text, user_id uuid, sent_at timestamptz default now(), primary key (day, user_id))");
  await c.query("alter table public.report_sent enable row level security");
}

async function maybeSend(c, opts){
  const now = Date.now(), local = new Date(now - OFF), day = local.toISOString().slice(0, 10);
  if (!(opts && opts.force) && local.getUTCHours() < HOUR) return null;
  await ensure(c);
  const leads = (await c.query("select id, role from public.app_users where role in ('head','manager') and active")).rows;
  const pending = [];
  for (const l of leads){
    if (opts && opts.only && opts.only !== l.id) continue;
    const done = (await c.query("select 1 from public.report_sent where day=$1 and user_id=$2", [day, l.id])).rows[0];
    if (!done || (opts && opts.force)) pending.push(l);
  }
  if (!pending.length) return {day, enviados:0};
  const from = Date.parse(day + "T00:00:00-05:00"), to = from + DAY, inDay = t => { t = Number(t) || 0; return t >= from && t < to; };
  // equipo: cada AM es de su manager; los que no tienen manager son del primero (igual que en la app)
  const roles = {}; (await c.query("select path, data from public.docs where parent='roles'")).rows.forEach(r => roles[r.path.split("/")[1]] = r.data || {});
  const members = (await c.query("select path from public.docs where parent='members'")).rows.map(r => r.path.split("/")[1]);
  const mgrs = members.filter(u => (roles[u] || {}).role === "manager"), headIds = leads.filter(l => l.role === "head").map(l => l.id);
  const ams = members.filter(u => !(roles[u] || {}).role || roles[u].role === "am").filter(u => !headIds.includes(u));
  const teamOf = l => l.role === "head" ? ams : ams.filter(u => ((roles[u] || {}).managerId || mgrs[0]) === l.id);
  // datos del día
  const items = (await c.query("select path, data from public.docs where path like 'meets/%/items/%'")).rows;
  const vals = (await c.query("select data from public.docs where parent='validations'")).rows.map(r => r.data || {});
  const evs = (await c.query("select path, data from public.docs where path like 'points/%/ev/%'")).rows;
  let sent = 0;
  for (const l of pending){
    const team = new Set(teamOf(l));
    const reg = items.filter(r => team.has(r.path.split("/")[1]) && inDay((r.data || {}).createdAt)).length;
    const tom = vals.filter(v => team.has(v.uid) && v.status === "attended" && inDay(v.decidedAt)).length;
    const n = ms => evs.filter(r => team.has(r.path.split("/")[1]) && (r.data || {}).ms === ms && inDay((r.data || {}).at)).length;
    const gus = n("legusto"), apr = n("aprobado"), pub = n("publicado");
    const parts = [`${reg} meet${reg === 1 ? "" : "s"} agendado${reg === 1 ? "" : "s"}`, `${tom} pitch${tom === 1 ? "" : "es"} tomado${tom === 1 ? "" : "s"}`];
    if (gus) parts.push(`${gus} le${gus === 1 ? "" : "s"} gustó`); if (apr) parts.push(`${apr} skeleton aprobado${apr === 1 ? "" : "s"}`); if (pub) parts.push(`${pub} publicado${pub === 1 ? "" : "s"} 🎉`);
    const title = l.role === "head" ? "📊 Reporte del día · equipo" : "📊 Reporte del día · tu equipo";
    sent += await sendTo(c, [l.id], {title, body:`Hoy: ${parts.join(" · ")}. Toca para ver el detalle.`, url:"/?tab=report&day=" + day, tag:"report-" + day});
    await c.query("insert into public.report_sent (day, user_id) values ($1,$2) on conflict do nothing", [day, l.id]);
  }
  return {day, enviados:sent, personas:pending.length};
}
module.exports = {maybeSend, HOUR};
