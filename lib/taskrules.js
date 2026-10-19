// Tareas que se repiten cada semana (p. ej. "40 candidatos para la Lista de Mich, entrega cada miércoles").
// La regla vive en taskRules/<id>; cada semana, cuando vence la entrega, se crea la siguiente tarea para cada persona
// con la misma hora de entrega (6:00 pm Cancún). Lo corre push-check cada minuto; el id fijo evita duplicados.
const { sendTo } = require("./push");
const OFF = 5 * 3600e3, DAY = 864e5;
const MICH_NOTE = "Influencers fitness de +35K seguidores para que Mich los contacte. Agrégalos aquí abajo; si ya están en la lista no cuentan. Entrega: miércoles 6 pm.";
const dueOn = (dateStr) => Date.parse(dateStr + "T18:00:00-05:00");
function nextDue(weekday, after){ // próxima fecha con ese día de la semana, a las 6 pm, después de "after"
  const l = new Date(after - OFF); let d = new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()));
  for (let i = 0; i < 8; i++){ const ds = d.toISOString().slice(0, 10), t = dueOn(ds); if (d.getUTCDay() === weekday && t > after) return {ds, t}; d = new Date(d.getTime() + DAY); }
  return null;
}
async function run(c){
  const rules = (await c.query("select id, data from public.docs where parent='taskRules'")).rows.filter(r => r.data && r.data.active !== false);
  if (!rules.length) return null;
  // descripción corta para las tareas de la Lista de Mich (la regla y las tareas abiertas); solo cambia si es la versión larga anterior
  for (const r of rules) if (r.data.metric === "mich" && r.data.note !== MICH_NOTE && /^Propón/.test(r.data.note || "")){
    await c.query("update public.docs set data = data || jsonb_build_object('note', $2::text), version = version + 1, updated_at = now() where path = $1", ["taskRules/" + r.id, MICH_NOTE]);
    await c.query(`update public.docs set data = data || jsonb_build_object('note', $2::text), version = version + 1, updated_at = now()
      where path like 'meets/%/tasks/%' and data->>'ruleId' = $1 and coalesce(data->>'status','todo') <> 'done' and data->>'note' like 'Propón%'`, [r.id, MICH_NOTE]);
    r.data.note = MICH_NOTE;
  }
  const roles = {}; (await c.query("select path, data from public.docs where parent='roles'")).rows.forEach(r => roles[r.path.split("/")[1]] = r.data || {});
  const members = (await c.query("select path from public.docs where parent='members'")).rows.map(r => r.path.split("/")[1]);
  const heads = (await c.query("select id from public.app_users where role='head'")).rows.map(r => r.id);
  const mgrs = members.filter(u => (roles[u] || {}).role === "manager");
  const ams = members.filter(u => (!(roles[u] || {}).role || roles[u].role === "am") && !heads.includes(u));
  const now = Date.now(); let made = 0;
  for (const r of rules){
    const R = r.data, by = R.by;
    const targets = R.to === "__team" ? (heads.includes(by) ? ams : ams.filter(u => ((roles[u] || {}).managerId || mgrs[0]) === by)) : (Array.isArray(R.to) ? R.to : []);
    for (const u of targets){
      const last = (await c.query("select max((data->>'dueAt')::bigint) m from public.docs where parent=$1 and data->>'ruleId'=$2", [`meets/${u}/tasks`, r.id])).rows[0].m;
      if (last && Number(last) > now) continue; // la de esta semana sigue abierta
      const nx = nextDue(Number(R.weekday), now); if (!nx) continue;
      const id = `r_${r.id}_${nx.ds}`, path = `meets/${u}/tasks/${id}`;
      const data = {title:R.title, note:R.note || "", dueAt:nx.t, status:"todo", by, byName:R.byName || "", createdAt:now, ruleId:r.id,
        ...(R.metric ? {metric:R.metric, goal:Number(R.goal) || 0, from:last ? Number(last) : now} : {}), ...(Array.isArray(R.files) && R.files.length ? {files:R.files} : {})};
      const ins = await c.query("insert into public.docs (path, data) values ($1,$2) on conflict (path) do nothing returning 1", [path, data]);
      if (ins.rows[0]){ made++; await sendTo(c, [u], {title:`Nueva tarea de ${R.byName || "tu líder"}`, body:R.title, url:`/?tab=agenda&task=${encodeURIComponent(u + "/" + id)}`, tag:"task-" + id}).catch(() => {}); }
    }
  }
  return made ? {creadas:made} : null;
}
module.exports = {run, nextDue};
