// Manda el reporte diario ahora mismo a quien lo pide (Head o Manager), para probar la notificación.
const { withPg, userFromReq } = require("../lib/google");
const { init } = require("../lib/push");
const report = require("../lib/report");
module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") return res.status(405).json({error:"POST"});
  const me = await userFromReq(req);
  if (!me) return res.status(401).json({error:"Sesión no válida"});
  
  try{ res.json(await withPg(async c => { await init(c); return await report.maybeSend(c, {force:true, only:me.id}) || {enviados:0}; })); }
  catch(err){ res.status(500).json({error:String(err.message || err)}); }
};
