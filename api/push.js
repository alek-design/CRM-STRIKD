// GET: llave pública para suscribirse · POST {subscription}: guardar este dispositivo · DELETE: quitarlo · POST {test:true}: prueba
const { withPg, userFromReq } = require("../lib/google");
const { vapid, sendTo, init } = require("../lib/push");
module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  const me = await userFromReq(req);
  if (!me) return res.status(401).json({error:"Sesión no válida"});
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  try{
    const out = await withPg(async c => {
      await init(c);
      if (req.method === "GET"){ const k = await vapid(c); const n = (await c.query("select count(*)::int n from public.push_subs where user_id=$1", [me.id])).rows[0].n; return {publicKey:k.publicKey, devices:n}; }
      if (req.method === "DELETE"){ await c.query("delete from public.push_subs where endpoint=$1 and user_id=$2", [String(body.endpoint || ""), me.id]); return {ok:true}; }
      if (body.test){ const n = await sendTo(c, [me.id], {title:"STRIKD", body:"Listo: así te van a llegar los mensajes nuevos de WhatsApp.", url:"/?tab=msgs", tag:"prueba"}); return {sent:n}; }
      const sub = body.subscription;
      if (!sub || !sub.endpoint || !sub.keys) throw Object.assign(new Error("Suscripción inválida"), {status:400});
      await c.query(`insert into public.push_subs (endpoint, user_id, sub, ua) values ($1,$2,$3,$4)
        on conflict (endpoint) do update set user_id=excluded.user_id, sub=excluded.sub, ua=excluded.ua`, [sub.endpoint, me.id, JSON.stringify(sub), String(req.headers["user-agent"] || "").slice(0, 200)]);
      return {ok:true};
    });
    res.json(out);
  }catch(err){ res.status(err.status || 500).json({error:String(err.message || err)}); }
};
