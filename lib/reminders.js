// Recordatorios personales: a la hora que se pidió, le llega la notificación a su dueño (una sola vez).
const { sendTo } = require("./push");
async function run(c){
  const now = Date.now();
  const rows = (await c.query(`select path, data from public.docs where path like 'meets/%/reminders/%'
    and coalesce((data->>'done')::boolean,false) = false and (data->>'at')::bigint <= $1 and (data->>'at')::bigint > $2
    and (data->>'notifiedAt') is null`, [now, now - 3 * 864e5])).rows;
  let sent = 0;
  for (const r of rows){
    const [, uid, , id] = r.path.split("/"), d = r.data || {};
    await c.query("update public.docs set data = data || jsonb_build_object('notifiedAt', $2::bigint), updated_at=now(), version=version+1 where path=$1", [r.path, now]);
    sent += await sendTo(c, [uid], {title:"⏰ Recordatorio", body:(d.name ? d.name + ": " : "") + String(d.text || "").slice(0, 150), url:d.conv ? "/?tab=msgs&conv=" + encodeURIComponent(d.conv) : "/?tab=agenda", tag:"rem-" + id}).catch(() => 0);
  }
  return rows.length ? {recordatorios:rows.length, enviadas:sent} : null;
}
module.exports = {run};
