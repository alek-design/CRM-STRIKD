// Manda a la persona a la ventana de permiso de Google.
const { env, userFromReq, makeState, redirectUri } = require("../../lib/google");
module.exports = async (req, res) => {
  const e = env();
  if (!e.gid || !e.gsecret) return res.status(500).send("Falta GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en Vercel.");
  const me = await userFromReq(req);
  if (!me) return res.status(401).send("Sesión no válida. Vuelve a entrar a la página.");
  const x = req.query.extra !== undefined;
  const q = new URLSearchParams({client_id:e.gid, redirect_uri:redirectUri(req), response_type:"code", access_type:"offline", prompt:"select_account consent", include_granted_scopes:"true",
    scope:"openid email https://www.googleapis.com/auth/calendar.events", state:makeState(me.id + (x ? "~x" : ""))});
  // cuenta extra: el nombre corto viaja en una cookie de 15 min
  if (x) res.setHeader("set-cookie", `gx_name=${encodeURIComponent(String(req.query.extra).slice(0, 16))}; Path=/api/google; Max-Age=900; HttpOnly; Secure; SameSite=Lax`);
  // sin login_hint: Google muestra el selector de cuentas y cada quien elige con cuál conectar (p. ej. su correo de STRIKD)
  res.redirect(302, "https://accounts.google.com/o/oauth2/v2/auth?" + q);
};
