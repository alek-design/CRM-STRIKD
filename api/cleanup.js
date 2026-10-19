// Borra los datos de ejemplo (personas "(ejemplo)" del demo y todo lo suyo). Solo el Head.
// GET = cuenta lo que se borraría (no borra nada) · POST {confirm:true} = borra.
// Ejemplo = miembros con demoName que NO son usuarios reales (app_users). Nunca toca a usuarios reales.
const { withPg, userFromReq } = require("../lib/google");
module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  const me = await userFromReq(req);
  if (!me) return res.status(401).json({error:"Sesión no válida"});
  if (me.role !== "head") return res.status(403).json({error:"Solo el Head"});
  const go = req.method === "POST" && (typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {})).confirm === true;
  try{
    const out = await withPg(async c => {
      const real = new Set((await c.query("select id::text id from public.app_users")).rows.map(r => r.id));
      const demo = (await c.query("select split_part(path,'/',2) uid from public.docs where parent='members' and (data ? 'demoName' or split_part(path,'/',2) like 'u_demo%')")).rows
        .map(r => r.uid).filter(u => !real.has(u));
      if (!demo.length) return {ejemplo:0, borrados:0, nada:true};
      const pats = demo.flatMap(u => [`members/${u}`, `roles/${u}`]);
      const likes = demo.flatMap(u => [`meets/${u}/%`, `points/${u}/%`]);
      const q = `select path from public.docs where path = any($1) or path like any($2)
        or (parent in ('validations','prospectIndex','vipIndex') and data->>'uid' = any($3))`;
      const rows = (await c.query(q, [pats, likes, demo])).rows.map(r => r.path);
      const by = {}; rows.forEach(p => { const k = p.split("/")[0] + (p.startsWith("meets/") ? "/" + p.split("/")[2] : ""); by[k] = (by[k] || 0) + 1; });
      if (!go) return {ejemplo:demo.length, docs:rows.length, detalle:by, borrados:0};
      const del = await c.query(`delete from public.docs where path = any($1)`, [rows]);
      return {ejemplo:demo.length, docs:rows.length, detalle:by, borrados:del.rowCount};
    });
    res.json(out);
  }catch(err){ res.status(500).json({error:String(err.message || err)}); }
};
