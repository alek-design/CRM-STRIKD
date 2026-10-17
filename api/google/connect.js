// Manda a la persona a la ventana de permiso de Google.
const { env, userFromReq, makeState, redirectUri } = require("../../lib/google");
module.exports = async (req, res) => {
  const e = env();
  if (!e.gid || !e.gsecret) return res.status(500).send("Falta GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en Vercel.");
  const me = await userFromReq(req);
  if (!me) return res.status(401).send("Sesión no válida. Vuelve a entrar a la página.");
  const q = new URLSearchParams({client_id:e.gid, redirect_uri:redirectUri(req), response_type:"code", access_type:"offline", prompt:"consent", include_granted_scopes:"true",
    scope:"openid email https://www.googleapis.com/auth/calendar.events", state:makeState(me.id), login_hint:me.email || ""});
  res.redirect(302, "https://accounts.google.com/o/oauth2/v2/auth?" + q);
};
