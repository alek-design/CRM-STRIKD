// Congela el resultado de cada semana al cierre (viernes 6:00 pm, hora Cancún).
// Lo que se decida después de cerrar ya no cambia esa semana: cuenta en la semana en que se decide.
const OFF = 5 * 3600e3, DAY = 864e5;
const PTS = {tomado:1, legusto:2, aprobado:3, progweb:4, publicado:5}, PMULT = {1:1, 2:2.5, 3:5};
function weekEnd(ts){ // mismo cálculo que el tablero
  const l = ts - OFF, d = new Date(l);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let end = dayStart + ((5 - d.getUTCDay() + 7) % 7) * DAY + 18 * 3600e3;
  if (end <= l) end += 7 * DAY;
  return end + OFF;
}
const keyOf = end => new Date(end - OFF).toISOString().slice(0, 10);
async function run(c){
  const now = Date.now(), lastEnd = weekEnd(now) - 7 * DAY;
  if (now < lastEnd) return null;
  const key = keyOf(lastEnd);
  if ((await c.query("select 1 from public.docs where path=$1", ["weeks/" + key])).rows[0]) return null;
  const t = {}, g = u => (t[u] ||= {pts:0, tom:0, valid:0, noshow:0, rejected:0, legusto:0, aprobado:0, progweb:0, publicado:0});
  (await c.query("select data from public.docs where parent='validations' and data->>'week'=$1", [key])).rows.forEach(({data:v}) => {
    if (!v || !v.uid || v.void) return; const r = g(v.uid);
    if (v.status === "attended"){ r.tom++; r.pts += PTS.tomado * (PMULT[Number(v.perfil)] || 1); }
    else if (v.status === "valid") r.valid++; else if (v.status === "noshow") r.noshow++; else if (v.status === "rejected") r.rejected++;
  });
  (await c.query("select path, data from public.docs where path like 'points/%/ev/%' and data->>'week'=$1", [key])).rows.forEach(({path, data:e}) => {
    if (!e || e.void || !PTS[e.ms]) return; const r = g(e.uid || path.split("/")[1]);
    r[e.ms]++; r.pts += typeof e.pts === "number" ? e.pts : PTS[e.ms];
  });
  Object.values(t).forEach(r => { r.pts = Math.round(r.pts * 10) / 10; });
  await c.query("insert into public.docs (path, data) values ($1,$2) on conflict (path) do nothing", ["weeks/" + key, {key, at:now, closedAt:lastEnd, t}]);
  return {semanaCerrada:key};
}
module.exports = {run, weekEnd, keyOf};
