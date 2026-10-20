// Reporte diario: a las 9:00 pm (Cancún) le llega al Head (todo el equipo) y a cada Manager (sus AMs) una notificación
// con los números del día. Al tocarla abre "Reporte del día" en la app, que trae el detalle completo.
// Lo llama push-check (cada minuto); se manda una sola vez por día y por persona.
const { sendTo } = require("./push");
const resptime = require("./resptime");
const OFF = 5 * 3600e3, DAY = 864e5, HOUR = 21;

async function ensure(c){
  await c.query("create table if not exists public.report_sent (day text, user_id uuid, sent_at timestamptz default now(), primary key (day, user_id))");
  await c.query("alter table public.report_sent enable row level security");
  await c.query("alter table public.report_sent add column if not exists ok int");
  await c.query("alter table public.report_sent add column if not exists note text");
}

// Manda y registra. Si la persona tiene dispositivos pero no llegó a ninguno, se reintenta el siguiente minuto (hasta las 11:59 pm).
async function deliver(c, uid, day, payload, opts){
  const subs = Number((await c.query("select count(*)::int n from public.push_subs where user_id=$1", [uid])).rows[0].n) || 0;
  const ok = subs ? await sendTo(c, [uid], payload) : 0;
  const late = new Date(Date.now() - OFF).getUTCHours() >= 23;
  const note = !subs ? "sin dispositivo con notificaciones" : ok ? "" : "no llegó: " + ((sendTo.lastErrors || [])[0] || "error");
  if (ok || !subs || late || (opts && opts.force))
    await c.query(`insert into public.report_sent (day, user_id, ok, note) values ($1,$2,$3,$4)
      on conflict (day, user_id) do update set ok=excluded.ok, note=excluded.note, sent_at=now()`, [day, uid, ok, note]);
  return ok;
}
async function maybeSend(c, opts){
  const now = Date.now(), local = new Date(now - OFF), day = local.toISOString().slice(0, 10);
  if (!(opts && opts.force) && local.getUTCHours() < HOUR) return null;
  const dow = local.getUTCDay();
  if (!(opts && opts.force) && (dow === 0 || dow === 6)) return null; // sábado y domingo no hay reporte; el del lunes trae el fin de semana
  await ensure(c);
  const leads = (await c.query("select id, role from public.app_users where role in ('head','manager') and active")).rows;
  // Influencer Outreach (Mich) también recibe el suyo
  const inflIds = (await c.query("select split_part(path,'/',2) id from public.docs where parent='roles' and data->>'role'='influencer'")).rows.map(r => r.id);
  if (inflIds.length) (await c.query("select id from public.app_users where id::text = any($1) and active", [inflIds])).rows.forEach(r => leads.push({id:r.id, role:"influencer"}));
  const pending = [];
  for (const l of leads){
    if (opts && opts.only && opts.only !== l.id) continue;
    const done = (await c.query("select 1 from public.report_sent where day=$1 and user_id=$2", [day, l.id])).rows[0];
    if (!done || (opts && opts.force)) pending.push(l);
  }
  if (!pending.length) return {day, enviados:0};
  const to = Date.parse(day + "T00:00:00-05:00") + DAY, from = to - (dow === 1 ? 3 : 1) * DAY, inDay = t => { t = Number(t) || 0; return t >= from && t < to; };
  // equipo: cada AM es de su manager; los que no tienen manager son del primero (igual que en la app)
  const roles = {}; (await c.query("select path, data from public.docs where parent='roles'")).rows.forEach(r => roles[r.path.split("/")[1]] = r.data || {});
  const members = (await c.query("select path from public.docs where parent='members'")).rows.map(r => r.path.split("/")[1]);
  const mgrs = members.filter(u => (roles[u] || {}).role === "manager"), headIds = leads.filter(l => l.role === "head").map(l => l.id);
  const ams = members.filter(u => !(roles[u] || {}).role || roles[u].role === "am").filter(u => !headIds.includes(u));
  // prospectos: los de los AM y también los que están a nombre del Head, el Manager o la Influencer
  const everyone = [...new Set(members.concat(headIds))];
  const teamOf = l => l.role === "head" ? everyone : ams.filter(u => ((roles[u] || {}).managerId || mgrs[0]) === l.id).concat([l.id]);
  // datos del día
  const items = (await c.query("select path, data from public.docs where path like 'meets/%/items/%'")).rows;
  const vals = (await c.query("select data from public.docs where parent='validations'")).rows.map(r => r.data || {});
  const evs = (await c.query("select path, data from public.docs where path like 'points/%/ev/%'")).rows;
  const vips = pending.some(l => l.role === "influencer") ? (await c.query("select data from public.docs where path like 'meets/%/vip/%'")).rows.map(r => r.data || {}) : [];
  try{ await resptime.stats(c, from, to); }catch(_){} // asegura las tablas
  const fmtM = ms => ms == null ? "" : ms < 60e3 ? "<1 min" : ms < 3600e3 ? Math.round(ms/60e3) + " min" : (Math.round(ms/360e3)/10) + " h";
  let sent = 0;
  for (const l of pending){
    if (l.role === "influencer"){
      const cont = vips.filter(x => x.contactedBy === l.id && inDay(x.contactedAt)).length;
      const ag = vips.filter(x => x.status === "agendo" && inDay(x.statusAt)).length;
      const nuevos = vips.filter(x => inDay(x.createdAt)).length, pend = vips.filter(x => (x.status || "nuevo") === "nuevo").length;
      const body = `${dow === 1 ? "Sáb a lun" : "Hoy"}: ${cont} contactado${cont === 1 ? "" : "s"} · ${ag} agendaron meet · ${nuevos} nuevo${nuevos === 1 ? "" : "s"} en tu lista. Por contactar: ${pend}.`;
      sent += await deliver(c, l.id, day, {title:dow === 1 ? "📊 Tu reporte (sáb a lun)" : "📊 Tu reporte del día", body, url:"/?tab=report&day=" + day, tag:"report-" + day}, opts);
      continue;
    }
    const team = new Set(teamOf(l));
    const reg = items.filter(r => team.has(r.path.split("/")[1]) && inDay((r.data || {}).createdAt)).length;
    const tom = vals.filter(v => team.has(v.uid) && v.status === "attended" && inDay(v.decidedAt)).length;
    const n = ms => evs.filter(r => team.has(r.path.split("/")[1]) && (r.data || {}).ms === ms && inDay((r.data || {}).at)).length;
    const gus = n("legusto"), apr = n("aprobado"), pub = n("publicado");
    const parts = [`${reg} meet${reg === 1 ? "" : "s"} agendado${reg === 1 ? "" : "s"}`, `${tom} pitch${tom === 1 ? "" : "es"} tomado${tom === 1 ? "" : "s"}`];
    try{ const ms = (await c.query("select ms from public.iskra_resp where out_at >= to_timestamp($1/1000.0) and out_at < to_timestamp($2/1000.0) and coalesce(responder, owner)::text = any($3)", [from, to, [...team]])).rows.map(r => Number(r.ms)).sort((a, b) => a - b);
      if (ms.length) parts.push(`WhatsApp: responden en ${fmtM(ms[Math.floor(ms.length/2)])}`); }catch(_){}
    if (gus) parts.push(`${gus} le${gus === 1 ? "" : "s"} gustó`); if (apr) parts.push(`${apr} skeleton aprobado${apr === 1 ? "" : "s"}`); if (pub) parts.push(`${pub} publicado${pub === 1 ? "" : "s"} 🎉`);
    const title = (l.role === "head" ? "📊 Reporte del día · equipo" : "📊 Reporte del día · tu equipo") + (dow === 1 ? " (sáb a lun)" : "");
    sent += await deliver(c, l.id, day, {title, body:`${dow === 1 ? "Sáb a lun" : "Hoy"}: ${parts.join(" · ")}. Toca para ver el detalle.`, url:"/?tab=report&day=" + day, tag:"report-" + day}, opts);
  }
  return {day, enviados:sent, personas:pending.length};
}
module.exports = {maybeSend, HOUR};
