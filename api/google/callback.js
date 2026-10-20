// Google regresa aquí con el permiso: guardamos el token y volvemos a la página.
const { env, withPg, readState, redirectUri } = require("../../lib/google");
module.exports = async (req, res) => {
  const st = readState(req.query.state) || "", extra = st.endsWith("~x"), gm = (st.match(/~(gg|gs)$/) || [])[1], uid = st.replace(/~(x|gg|gs)$/, "");
  if (!uid) return res.redirect(302, "/?google=error");
  if (req.query.error || !req.query.code) return res.redirect(302, "/?google=cancelado");
  const e = env();
  const r = await fetch("https://oauth2.googleapis.com/token", {method:"POST", headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({code:req.query.code, client_id:e.gid, client_secret:e.gsecret, redirect_uri:redirectUri(req), grant_type:"authorization_code"})});
  const j = await r.json();
  if (!r.ok || !j.refresh_token) return res.redirect(302, "/?google=error");
  let email = "";
  try{ email = JSON.parse(Buffer.from(String(j.id_token).split(".")[1], "base64url").toString()).email || ""; }catch(_){}
  if (gm){ // Gmail para los emails automáticos
    if (!email) return res.redirect(302, "/?google=error");
    await withPg(c => require("../../lib/gmail").save(c, gm === "gg" ? "general" : uid, j, email.toLowerCase()));
    return res.redirect(302, "/?google=gmail");
  }
  if (extra){
    // otra cuenta (p. ej. la de otro trabajo): se guarda aparte y se agrega a "Otros calendarios" como conectada directo
    if (!email) return res.redirect(302, "/?google=error");
    email = email.toLowerCase();
    const ck = String(req.headers.cookie || "").match(/(?:^|;\s*)gx_name=([^;]*)/), name = (ck ? decodeURIComponent(ck[1]) : "").trim().slice(0, 16) || email.split("@")[1].split(".")[0];
    await withPg(async c => {
      const me = (await c.query("select email from public.google_tokens where user_id=$1", [uid])).rows[0];
      await c.query(`insert into public.google_extra_tokens (user_id,email,refresh_token,access_token,expires_at,connected_at)
        values ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval, now())
        on conflict (user_id,email) do update set refresh_token=excluded.refresh_token, access_token=excluded.access_token, expires_at=excluded.expires_at, connected_at=now()`,
        [uid, email, j.refresh_token, j.access_token, String(j.expires_in || 3500)]);
      if (me && String(me.email || "").toLowerCase() === email) return;
      const row = (await c.query("select data from public.docs where path=$1", ["members/" + uid])).rows[0];
      const data = (row && row.data) || {}, list = (Array.isArray(data.extraCals) ? data.extraCals : []).filter(x => x && String(x.id).toLowerCase() !== email);
      list.push({id:email, name, linked:true});
      await c.query(`insert into public.docs (path, data) values ($1, $2::jsonb)
        on conflict (path) do update set data = public.docs.data || jsonb_build_object('extraCals', $3::jsonb), version = public.docs.version + 1, updated_at = now()`,
        ["members/" + uid, JSON.stringify({...data, extraCals:list}), JSON.stringify(list)]);
    });
    res.setHeader("set-cookie", "gx_name=; Path=/api/google; Max-Age=0");
    return res.redirect(302, "/?google=extra");
  }
  await withPg(c => c.query(`insert into public.google_tokens (user_id,email,refresh_token,access_token,expires_at,connected_at)
      values ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval, now())
      on conflict (user_id) do update set email=excluded.email, refresh_token=excluded.refresh_token, access_token=excluded.access_token, expires_at=excluded.expires_at, connected_at=now()`,
      [uid, email, j.refresh_token, j.access_token, String(j.expires_in || 3500)]));
  res.redirect(302, "/?google=ok");
};
