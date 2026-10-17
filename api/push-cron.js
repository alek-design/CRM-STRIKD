// Solo el Head: programa en la base de datos (pg_cron + pg_net) que cada minuto se llame /api/push-check.
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
      const key = (await cronKey(c)).key;
      await c.query("create extension if not exists pg_cron with schema extensions").catch(() => c.query("create extension if not exists pg_cron"));
      await c.query("create extension if not exists pg_net with schema extensions").catch(() => c.query("create extension if not exists pg_net"));
      await c.query("select cron.unschedule(jobid) from cron.job where jobname='strikd-push'");
      const sql = `select net.http_post(url:='https://${host}/api/push-check', headers:=jsonb_build_object('x-strikd-cron','${key}','content-type','application/json'), body:='{}'::jsonb)`;
      await c.query("select cron.schedule('strikd-push', '* * * * *', $1)", [sql]);
      return {ok:true, cada:"1 minuto", url:`https://${host}/api/push-check`};
    });
    res.json(out);
  }catch(err){ res.status(500).json({error:String(err.message || err)}); }
};
