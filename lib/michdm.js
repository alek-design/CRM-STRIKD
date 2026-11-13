// Recordatorio de DMs para la Influencer Outreach (Mich) · Alek, 12 nov 2026
// Lunes a viernes a las 12:00, 3:00 y 6:00 pm (Cancún) le llega una push con cuántos DMs lleva hoy y cuántos le faltan para la meta (30).
// La meta se puede cambiar en config/main.michDmGoal. Lo llama push-check cada minuto; cada aviso sale una sola vez.
const { sendTo } = require("./push");
const OFF = 5 * 3600e3, DAY = 864e5, SLOTS = [12, 15, 18];

async function ensure(c){
  await c.query("create table if not exists public.dm_nudge_sent (day text, slot int, user_id uuid, ok int, sent_at timestamptz default now(), primary key (day, slot, user_id))");
  await c.query("alter table public.dm_nudge_sent enable row level security");
}
function text(n, goal, slot){
  const left = Math.max(0, goal - n), bar = "▰".repeat(Math.min(10, Math.floor(n / goal * 10))) + "▱".repeat(Math.max(0, 10 - Math.floor(n / goal * 10)));
  if (left === 0) return {title:`✅ DMs de hoy: ${n}/${goal}`, body:`${bar}  ¡Meta cumplida!${n > goal ? ` Vas ${n - goal} arriba.` : ""}`};
  const when = slot === 18 ? "Último empujón del día." : slot === 15 ? "Vas a media tarde." : "Arrancamos el día.";
  return {title:`📲 DMs de hoy: ${n}/${goal} · te faltan ${left}`, body:`${bar}  ${when}`};
}
async function run(c, opts){
  const now = Date.now(), local = new Date(now - OFF), day = local.toISOString().slice(0, 10), h = local.getUTCHours(), dow = local.getUTCDay();
  const force = opts && opts.force;
  // solo dentro de la hora del aviso (si el cron se atrasa unos minutos, igual sale; no se manda un aviso viejo horas después)
  const slot = force ? (opts.slot || SLOTS.filter(s => s <= h).pop() || 12) : SLOTS.find(s => s === h);
  if (!slot || (!force && (dow === 0 || dow === 6))) return null;
  await ensure(c);
  const ids = (await c.query("select split_part(path,'/',2) id from public.docs where parent='roles' and data->>'role'='influencer'")).rows.map(r => r.id);
  if (!ids.length) return null;
  const users = (await c.query("select id::text id from public.app_users where id::text = any($1) and active", [ids])).rows.map(r => r.id);
  const cfg = ((await c.query("select data from public.docs where path='config/main'")).rows[0] || {}).data || {};
  const goal = Math.max(1, Number(cfg.michDmGoal) || 30);
  const from = Date.parse(day + "T00:00:00-05:00"), to = from + DAY;
  const vips = (await c.query("select data from public.docs where path like 'meets/%/vip/%' and coalesce(data->>'contactedAt','') <> ''")).rows.map(r => r.data || {});
  const out = [];
  for (const u of users){
    if (!force && (await c.query("select 1 from public.dm_nudge_sent where day=$1 and slot=$2 and user_id=$3", [day, slot, u])).rows[0]) continue;
    // DMs de hoy = perfiles marcados como contactados hoy por ella (o sin "contactedBy", que solo ella marca)
    const n = vips.filter(x => { const t = Number(x.contactedAt) || 0; return t >= from && t < to && (!x.contactedBy || x.contactedBy === u); }).length;
    const ok = await sendTo(c, [u], {...text(n, goal, slot), url:"/?tab=mich", tag:"mich-dm-" + day});
    await c.query("insert into public.dm_nudge_sent (day, slot, user_id, ok) values ($1,$2,$3,$4) on conflict (day, slot, user_id) do update set ok=excluded.ok, sent_at=now()", [day, slot, u, ok]);
    out.push({u, n, goal, slot, ok});
  }
  return out.length ? out : null;
}
module.exports = { run, text, SLOTS };
