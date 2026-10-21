// Tareas que se repiten cada semana (p. ej. "40 candidatos para la Lista de Mich, entrega cada miércoles").
// La regla vive en taskRules/<id>; cada semana, cuando vence la entrega, se crea la siguiente tarea para cada persona
// con la misma hora de entrega (6:00 pm Cancún). Lo corre push-check cada minuto; el id fijo evita duplicados.
const { sendTo } = require("./push");
const OFF = 5 * 3600e3, DAY = 864e5;
const MICH_NOTE = "Influencers fitness de +35K seguidores para que Mich los contacte. Agrégalos aquí abajo; si ya están en la lista no cuentan. Al menos 2 de cada 3 con su email (40 de 60). Entrega: miércoles 6 pm.";
const dueOn = (dateStr) => Date.parse(dateStr + "T18:00:00-05:00");
function nextDue(weekday, after){ // próxima fecha con ese día de la semana, a las 6 pm, después de "after"
  const l = new Date(after - OFF); let d = new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()));
  for (let i = 0; i < 8; i++){ const ds = d.toISOString().slice(0, 10), t = dueOn(ds); if (d.getUTCDay() === weekday && t > after) return {ds, t}; d = new Date(d.getTime() + DAY); }
  return null;
}
// tareas programadas: al llegar su hora se avisa a quien la recibe (antes no la ve)
async function publishDue(c){
  const now = Date.now();
  const rows = (await c.query(`select path, data from public.docs where path like 'meets/%/tasks/%' and data ? 'publishAt'
    and (data->>'publishAt')::bigint <= $1 and not (data ? 'publishNotified') and coalesce(data->>'status','todo') <> 'done' limit 50`, [now])).rows;
  for (const r of rows){
    const u = r.path.split("/")[1], id = r.path.split("/")[3], x = r.data || {};
    await c.query("update public.docs set data = data || jsonb_build_object('publishNotified', $2::bigint), version = version + 1, updated_at = now() where path = $1", [r.path, now]);
    await sendTo(c, [u], {title:`Nueva tarea de ${x.byName || "tu líder"}`, body:String(x.title || "") + (x.note ? " · " + String(x.note).slice(0, 100) : ""), url:`/?tab=agenda&task=${encodeURIComponent(u + "/" + id)}`, tag:"task-" + id}).catch(() => {});
  }
  return rows.length;
}
// avisos de vencimiento: a quien la tiene, la mañana del día que vence (9 am); a quien la asignó, cuando se vence sin entregar
async function dueAlerts(c){
  const now = Date.now(), l = new Date(now - OFF), today = l.toISOString().slice(0, 10);
  const rows = (await c.query(`select path, data from public.docs where path like 'meets/%/tasks/%' and data ? 'dueAt'
    and coalesce(data->>'status','todo') not in ('done','review') and coalesce((data->>'publishAt')::bigint, 0) <= $1
    and (not (data ? 'dueSoonAt') or not (data ? 'lateAt')) and (data->>'dueAt')::bigint between $2 and $3 limit 100`, [now, now - 3 * DAY, now + DAY])).rows;
  for (const r of rows){
    const u = r.path.split("/")[1], id = r.path.split("/")[3], x = r.data || {}, due = Number(x.dueAt), url = `/?tab=agenda&task=${encodeURIComponent(u + "/" + id)}`;
    const dueDay = new Date(due - OFF).toISOString().slice(0, 10);
    if (!x.dueSoonAt && dueDay === today && l.getUTCHours() >= 9 && due > now){
      await c.query("update public.docs set data = data || jsonb_build_object('dueSoonAt', $2::bigint) where path = $1", [r.path, now]);
      await sendTo(c, [u], {title:"⏰ Hoy vence una tarea", body:String(x.title || ""), url, tag:"due-" + id}).catch(() => {});
    }
    if (!x.lateAt && due < now){
      await c.query("update public.docs set data = data || jsonb_build_object('lateAt', $2::bigint) where path = $1", [r.path, now]);
      if (x.by && x.by !== u){
        const nm = ((await c.query("select name, email from public.app_users where id::text = $1", [u])).rows[0] || {});
        await sendTo(c, [x.by], {title:`Se venció sin entregar · ${String(nm.name || nm.email || "").split(" ")[0]}`, body:String(x.title || ""), url, tag:"late-" + id}).catch(() => {});
      }
    }
  }
}
async function run(c){
  try{ await publishDue(c); }catch(_){}
  try{ await dueAlerts(c); }catch(_){}
  const rules = (await c.query("select id, data from public.docs where parent='taskRules'")).rows.filter(r => r.data && r.data.active !== false);
  if (!rules.length) return null;
  // descripción corta para las tareas de la Lista de Mich (la regla y las tareas abiertas); solo cambia si es la versión larga anterior
  for (const r of rules) if (r.data.metric === "mich" && r.data.note !== MICH_NOTE && /^(Propón|Influencers fitness)/.test(r.data.note || "")){
    await c.query("update public.docs set data = data || jsonb_build_object('note', $2::text), version = version + 1, updated_at = now() where path = $1", ["taskRules/" + r.id, MICH_NOTE]);
    await c.query(`update public.docs set data = data || jsonb_build_object('note', $2::text), version = version + 1, updated_at = now()
      where path like 'meets/%/tasks/%' and data->>'ruleId' = $1 and coalesce(data->>'status','todo') <> 'done' and (data->>'note' like 'Propón%' or data->>'note' like 'Influencers fitness%')`, [r.id, MICH_NOTE]);
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
    const targets = R.to === "__team" ? (heads.includes(by) || (roles[by] || {}).role === "influencer" ? ams : ams.filter(u => ((roles[u] || {}).managerId || mgrs[0]) === by)) : (Array.isArray(R.to) ? R.to : []);
    const excl = new Set(Array.isArray(R.exclude) ? R.exclude : []); // personas que no la reciben (p. ej. tiene otras responsabilidades)
    for (const u of targets.filter(x => !excl.has(x))){
      const last = (await c.query("select max((data->>'dueAt')::bigint) m from public.docs where parent=$1 and data->>'ruleId'=$2", [`meets/${u}/tasks`, r.id])).rows[0].m;
      if (last && Number(last) > now) continue; // la de esta semana sigue abierta
      const nx = nextDue(Number(R.weekday), now); if (!nx) continue;
      const id = `r_${r.id}_${nx.ds}`, path = `meets/${u}/tasks/${id}`;
      if (Array.isArray(R.skip) && R.skip.includes(`${u}|${nx.ds}`)) continue; // la borraron a mano: esa semana no se vuelve a crear
      const data = {title:R.title, note:R.note || "", dueAt:nx.t, status:"todo", by, byName:R.byName || "", createdAt:now, ruleId:r.id,
        ...(R.metric ? {metric:R.metric, goal:Number(R.goal) || 0, from:last ? Number(last) : now} : {}), ...(Array.isArray(R.files) && R.files.length ? {files:R.files} : {})};
      const ins = await c.query("insert into public.docs (path, data) values ($1,$2) on conflict (path) do nothing returning 1", [path, data]);
      if (ins.rows[0]){ made++; await sendTo(c, [u], {title:`Nueva tarea de ${R.byName || "tu líder"}`, body:R.title, url:`/?tab=agenda&task=${encodeURIComponent(u + "/" + id)}`, tag:"task-" + id}).catch(() => {}); }
    }
  }
  return made ? {creadas:made} : null;
}
module.exports = {run, nextDue};
