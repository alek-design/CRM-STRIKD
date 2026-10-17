// ¿Está conectado? · POST {disconnect:true} para desconectar · ?all=1 (Head) para ver quién ya conectó.
const { withPg, userFromReq } = require("../../lib/google");
module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  const me = await userFromReq(req);
  if (!me) return res.status(401).json({error:"Sesión no válida"});
  try{
    if (req.method === "POST"){ await withPg(c => c.query("delete from public.google_tokens where user_id=$1", [me.id])); return res.json({ok:true}); }
    if (req.query.all && me.role === "head"){
      const rows = await withPg(c => c.query("select user_id, email from public.google_tokens")); return res.json({users: rows.rows});
    }
    const r = await withPg(c => c.query("select email from public.google_tokens where user_id=$1", [me.id]));
    res.json({connected: !!r.rows[0], email: r.rows[0] ? r.rows[0].email : "", configured: !!process.env.GOOGLE_CLIENT_ID});
  }catch(err){ res.status(500).json({error:String(err.message||err)}); }
};
