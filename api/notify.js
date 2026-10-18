// Notificación al celular por cambios de tareas (creación, estatus, comentarios).
// Head/Manager pueden avisarle a cualquiera del equipo; un AM solo a Head/Manager o a quien le asignó la tarea.
const { withPg, userFromReq } = require("../lib/google");
const { init, sendTo } = require("../lib/push");
const UID = /^[0-9a-f-]{36}$/i;
module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") return res.status(405).json({error:"POST"});
  const me = await userFromReq(req);
  if (!me) return res.status(401).json({error:"Sesión no válida"});
  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const to = [...new Set((Array.isArray(b.to) ? b.to : []).map(String).filter(u => UID.test(u) && u !== me.id))].slice(0, 20);
  if (!to.length) return res.json({ok:true, enviadas:0});
  try{
    const out = await withPg(async c => {
      await init(c);
      let allowed = to;
      if (me.role === "am"){
        const leads = new Set((await c.query("select id from public.app_users where role in ('head','manager') and active")).rows.map(r => r.id));
        const owner = b.taskOwner && UID.test(String(b.taskOwner)) ? String(b.taskOwner) : "";
        allowed = to.filter(u => leads.has(u) || u === owner);
      }
      if (!allowed.length) return {ok:true, enviadas:0};
      const sent = await sendTo(c, allowed, {title:String(b.title || "STRIKD").slice(0, 80), body:String(b.body || "").slice(0, 180), url:String(b.url || "/").slice(0, 200), tag:String(b.tag || "strikd").slice(0, 80)});
      return {ok:true, enviadas:sent};
    });
    res.json(out);
  }catch(err){ res.status(500).json({error:String(err.message || err)}); }
};
