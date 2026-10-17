// Borra los datos de ejemplo (demo) de la base. Solo el Head. No toca nada que haya registrado el equipo.
const { withPg, userFromReq } = require("../lib/google");
const WHERE = `path like '%u_demo_%'
  or coalesce(data->>'demo','') = 'true'
  or coalesce(data->>'uid','') like 'u_demo_%'
  or path like 'validations/demo%'
  or path like 'prospectIndex/%ejemplo%'
  or path like 'vipIndex/%ejemplo%'`;
module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  const me = await userFromReq(req);
  if (!me || me.role !== "head") return res.status(403).json({error:"Solo el Head puede borrar los datos de ejemplo."});
  try{
    const out = await withPg(async c => {
      if (req.method === "GET") return {count: Number((await c.query(`select count(*) from public.docs where ${WHERE}`)).rows[0].count)};
      if (req.method !== "POST") return {error:"POST"};
      const r = await c.query(`delete from public.docs where ${WHERE} returning path`);
      return {deleted: r.rowCount};
    });
    res.json(out);
  }catch(err){ res.status(500).json({error:String(err.message || err)}); }
};
