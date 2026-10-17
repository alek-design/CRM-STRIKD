// Puente con ISKRA (WhatsApp). La llave vive solo en Vercel (ISKRA_API_KEY); el navegador nunca la ve.
// Solo Head y Creator Partnerships Manager. Envíos: siempre por clic de una persona, con idempotency_key.
const { userFromReq } = require("../lib/google");
const BASE = (process.env.ISKRA_API_URL || "https://xglfamaaotmwulglwcui.supabase.co/functions/v1/public-api").replace(/\/$/, "");

const enc = encodeURIComponent;
const OPS = {
  whoami:        ()  => ["GET",  "/v1/whoami"],
  numbers:       ()  => ["GET",  "/v1/numbers"],
  templates:     ()  => ["GET",  "/v1/templates"],
  stats:         (i) => ["GET",  "/v1/stats/summary" + qs(i, ["from", "to", "period"])],
  conversations: (i) => ["GET",  "/v1/conversations" + qs(i, ["cursor", "limit", "q"])],
  messages:      (i) => ["GET",  `/v1/conversations/${enc(i.id || "")}/messages` + qs(i, ["cursor", "limit"])],
  reply:         ()  => ["POST", "/v1/messages/reply", true],
  send:          ()  => ["POST", "/v1/messages/send", true],
};
function qs(i, keys){ const p = new URLSearchParams(); keys.forEach(k => { if (i && i[k] != null && i[k] !== "") p.set(k, String(i[k])); }); const s = p.toString(); return s ? "?" + s : ""; }

module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") return res.status(405).json({error:"POST"});
  const me = await userFromReq(req);
  if (!me) return res.status(401).json({error:"Sesión no válida"});
  if (!["head", "manager"].includes(me.role)) return res.status(403).json({error:"Solo el Head y el Creator Partnerships Manager usan ISKRA."});
  const key = process.env.ISKRA_API_KEY;
  if (!key) return res.json({configured:false});
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const op = OPS[body.op];
  if (!op) return res.status(400).json({error:"Operación no permitida"});
  const [method, path, write] = op(body.input || {});
  if (body.op === "messages" && !(body.input || {}).id) return res.status(400).json({error:"Falta id"});
  let payload;
  if (write){
    payload = {...(body.input || {})};
    if (!payload.idempotency_key) return res.status(400).json({error:"Falta idempotency_key"});
  }
  try{
    const r = await fetch(BASE + path, {method, headers:{authorization:"Bearer " + key, "content-type":"application/json"}, body: payload ? JSON.stringify(payload) : undefined});
    const text = await r.text(); let j; try{ j = JSON.parse(text); }catch(_){ j = {raw:text.slice(0, 2000)}; }
    res.status(r.ok ? 200 : r.status).json(r.ok ? {configured:true, data:j} : {configured:true, error:(j && (j.error || j.message)) || ("ISKRA " + r.status), detail:j});
  }catch(err){ res.status(502).json({configured:true, error:"No se pudo hablar con ISKRA: " + String(err.message || err)}); }
};
