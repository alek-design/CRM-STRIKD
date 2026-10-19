// Solo el Head: diagnóstico de notificaciones (¿está programada la revisión de cada minuto?, ¿corre?, ¿quién tiene dispositivos?).
// Si la revisión no está programada, intenta programarla.
const { withPg, userFromReq } = require("../lib/google");
const { cronKey, init } = require("../lib/push");
module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  const me = await userFromReq(req);
  if (!me || me.role !== "head") return res.status(403).json({error:"Solo el Head"});
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  try{
    const out = await withPg(async c => {
      await init(c);
      const r = {revision_programada:false};
      const q = async (sql, args) => { try{ return (await c.query(sql, args)).rows; }catch(e){ r.errores = (r.errores || []).concat(e.message); return null; } };
      let job = await q("select jobid, schedule, active from cron.job where jobname='strikd-push'");
      if (!job || !job.length){
        const key = (await cronKey(c)).key;
        await q("create extension if not exists pg_cron with schema extensions");
        await q("create extension if not exists pg_net with schema extensions");
        const sql = `select net.http_post(url:='https://${host}/api/push-check', headers:=jsonb_build_object('x-strikd-cron','${key}','content-type','application/json'), body:='{}'::jsonb)`;
        await q("select cron.schedule('strikd-push', '* * * * *', $1)", [sql]);
        job = await q("select jobid, schedule, active from cron.job where jobname='strikd-push'");
        r.se_programo_ahora = !!(job && job.length);
      }
      r.revision_programada = !!(job && job.length && job[0].active);
      const runs = job && job.length ? await q("select status, return_message, start_time from cron.job_run_details where jobid=$1 order by start_time desc limit 3", [job[0].jobid]) : null;
      r.ultimas_ejecuciones = runs || [];
      const http = await q("select status_code, left(coalesce(content::text, error_msg, ''), 200) as respuesta, created from net._http_response order by created desc limit 3");
      r.ultimas_respuestas = http || [];
      r.dispositivos = (await q(`select coalesce(u.name, u.email) as persona, count(*)::int as dispositivos, max(s.last_ok) as ultima_notificacion
        from public.push_subs s left join public.app_users u on u.id = s.user_id group by 1 order by 1`)) || [];
      r.iskra = !!process.env.ISKRA_API_KEY;
      r.reporte_diario = (await q(`select r.day, coalesce(u.name, u.email) persona, r.ok as dispositivos_que_recibieron, r.note as nota, r.sent_at
        from public.report_sent r left join public.app_users u on u.id = r.user_id order by r.sent_at desc limit 8`)) || [];
      return r;
    });
    res.json(out);
  }catch(err){ res.status(500).json({error:String(err.message || err)}); }
};
