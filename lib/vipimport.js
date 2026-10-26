// Importación única de la lista de influencers que mandó Alek (26 oct 2026) a la lista de Mich.
// Sin repetidos: se salta a quien ya esté en la lista (vipIndex o mismo Instagram) o ya registrado como prospecto (prospectIndex).
// Queda a nombre de Mich (byMich). "Top Tier" → coronita (top). El resultado se guarda en config/vipImportOct26 y no se vuelve a correr.
const LIST = require("./data/vip-import-oct26.json");
const MARK = "config/vipImportOct26";

async function run(c){
  if ((await c.query("select 1 from public.docs where path=$1", [MARK])).rows[0]) return null;
  const who = (await c.query(`select u.id from public.app_users u join public.docs d on d.path = 'roles/' || u.id::text
    where d.data->>'role' = 'influencer' and coalesce(u.active, true) order by (u.name ilike 'mich%' or u.email ilike 'mich%') desc limit 1`)).rows[0]
    || (await c.query("select id from public.app_users where role='head' limit 1")).rows[0];
  if (!who) return null;
  const uid = String(who.id), now = Date.now(), added = [], skipped = [];
  // lo que ya hay en la lista de influencers (por Instagram)
  const have = new Set((await c.query(`select lower(coalesce(data->>'igKey','')) k, lower(coalesce(data->>'profile','')) p from public.docs where path like 'meets/%/vip/%'`)).rows
    .flatMap(r => [r.k, (r.p.match(/instagram\.com\/([a-z0-9._]+)/) || [])[1] ? "ig:" + r.p.match(/instagram\.com\/([a-z0-9._]+)/)[1].replace(/\.+$/, "") : ""]).filter(Boolean));
  for (const [i, x] of LIST.entries()){
    const key = "ig:" + x.h;
    if (have.has(key)){ skipped.push({h:x.h, por:"ya en la lista"}); continue; }
    const idx = (await c.query("select path from public.docs where path = any($1) and coalesce(data->>'uid','') <> ''", [["vipIndex/" + key, "prospectIndex/" + key]])).rows.map(r => r.path);
    if (idx.length){ skipped.push({h:x.h, por:idx[0].startsWith("vip") ? "ya en la lista" : "ya registrado como prospecto"}); continue; }
    const id = "imp26_" + x.h.replace(/[^a-z0-9_]/g, "_"), at = now + i;
    const data = {prospect:x.name, profile:`https://www.instagram.com/${x.h}/`, followers:x.fol, folRange:x.tier, notes:x.note || "", perfil:3,
      status:x.contactado ? "contactado" : "nuevo", createdAt:at, igKey:key, byMich:true, addedBy:uid, imported:"lista-26oct",
      ...(x.contactado ? {statusAt:at, contactedAt:at} : {}), ...(x.top ? {top:true, topAt:at, topBy:"import"} : {})};
    const ins = await c.query("insert into public.docs (path, data) values ($1, $2) on conflict (path) do nothing returning 1", [`meets/${uid}/vip/${id}`, data]);
    if (!ins.rows[0]){ skipped.push({h:x.h, por:"ya importado"}); continue; }
    await c.query("insert into public.docs (path, data) values ($1, $2) on conflict (path) do nothing", [`vipIndex/${key}`, {uid, vipId:id, at}]);
    have.add(key); added.push(x.h);
  }
  await c.query("insert into public.docs (path, data) values ($1, $2) on conflict (path) do nothing", [MARK, {at:now, uid, added:added.length, skipped}]);
  return {agregados:added.length, repetidos:skipped.length};
}
module.exports = {run};
