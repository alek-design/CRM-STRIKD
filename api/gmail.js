// Emails automáticos: estado de las cuentas de Gmail conectadas, envíos y desconectar.
// GET  → {general, me, people (Head/Manager), today, tpl (por plantilla: enviados / contestados)}
// POST {disconnect:"general"|"me"}
const { withPg, userFromReq } = require("../lib/google");
const gmail = require("../lib/gmail");
module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  const me = await userFromReq(req);
  if (!me) return res.status(401).json({error:"Sesión no válida"});
  const lead = me.role === "head" || me.role === "manager";
  try{
    const out = await withPg(async c => {
      await gmail.ensure(c);
      if (req.method === "POST"){
        const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
        const key = b.disconnect === "general" ? (me.role === "head" ? "general" : null) : b.disconnect === "me" ? me.id : null;
        if (!key) return {status:403, error:"Sin permiso"};
        await c.query("delete from public.gmail_tokens where key=$1", [key]); return {ok:true};
      }
      const rows = (await c.query("select key, email from public.gmail_tokens")).rows;
      const general = rows.find(r => r.key === "general") || null, mine = rows.find(r => r.key === me.id) || null;
      const day0 = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10) + "T05:00:00Z";
      const today = (await c.query("select sender, count(*)::int n from public.email_log where at >= $1 and status='sent' group by sender", [day0])).rows;
      const base = {general:general ? {email:general.email} : null, me:mine ? {email:mine.email} : null, today:Object.fromEntries(today.map(r => [r.sender, r.n])), limit:20};
      if (!lead) return base;
      const tpl = (await c.query(`select tpl, step, count(*)::int sent, count(*) filter (where status in ('replied','optout'))::int replied from public.email_log
        where status <> 'error' group by tpl, step`)).rows;
      return {...base, people:rows.filter(r => r.key !== "general").map(r => ({uid:r.key, email:r.email})), tpl};
    });
    res.status(out.status || 200).json(out);
  }catch(err){ res.status(500).json({error:String(err.message || err)}); }
};
