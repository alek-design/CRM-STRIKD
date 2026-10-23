// Responsable automático por perfil (Alek, 23 oct 2026): todo prospecto NUEVO de Perfil 1 queda con Rafa (partners@strikd.ai) de responsable.
// El correo sale de config/main.perfilInvite (por defecto {1:"partners@strikd.ai"}). Solo toca meets creados desde SINCE y sin responsable.
const SINCE = Date.parse("2026-10-23T20:10:00Z");
async function run(c){
  const cfg = ((await c.query("select data from public.docs where path='config/main'")).rows[0] || {}).data || {};
  if (cfg.perfilRespAuto === false) return null;
  const map = cfg.perfilInvite || {1:"partners@strikd.ai"}, out = [];
  for (const [pf, mail] of Object.entries(map)){
    if (!mail) continue;
    const u = (await c.query("select id from public.app_users where lower(email)=lower($1) and coalesce(active,true)", [String(mail)])).rows[0]; if (!u) continue;
    const r = await c.query(`update public.docs set data = data || jsonb_build_object('resp', $1::text, 'respAt', $3::bigint, 'respBy', 'auto'), version = version + 1, updated_at = now()
      where path like 'meets/%/items/%' and coalesce(data->>'perfil','1') = $2 and coalesce(data->>'resp','') = '' and coalesce(data->>'respBy','') <> 'none'
        and coalesce((data->>'createdAt')::bigint, 0) >= $4 returning path`, [String(u.id), String(pf), Date.now(), SINCE]);
    if (r.rows.length) out.push({perfil:pf, asignados:r.rows.length});
  }
  return out.length ? out : null;
}
module.exports = {run};
