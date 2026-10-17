// Google regresa aquí con el permiso: guardamos el token y volvemos a la página.
const { env, withPg, readState, redirectUri } = require("../../lib/google");
module.exports = async (req, res) => {
  const uid = readState(req.query.state);
  if (!uid) return res.redirect(302, "/?google=error");
  if (req.query.error || !req.query.code) return res.redirect(302, "/?google=cancelado");
  const e = env();
  const r = await fetch("https://oauth2.googleapis.com/token", {method:"POST", headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({code:req.query.code, client_id:e.gid, client_secret:e.gsecret, redirect_uri:redirectUri(req), grant_type:"authorization_code"})});
  const j = await r.json();
  if (!r.ok || !j.refresh_token) return res.redirect(302, "/?google=error");
  let email = "";
  try{ email = JSON.parse(Buffer.from(String(j.id_token).split(".")[1], "base64url").toString()).email || ""; }catch(_){}
  await withPg(c => c.query(`insert into public.google_tokens (user_id,email,refresh_token,access_token,expires_at,connected_at)
      values ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval, now())
      on conflict (user_id) do update set email=excluded.email, refresh_token=excluded.refresh_token, access_token=excluded.access_token, expires_at=excluded.expires_at, connected_at=now()`,
      [uid, email, j.refresh_token, j.access_token, String(j.expires_in || 3500)]));
  res.redirect(302, "/?google=ok");
};
