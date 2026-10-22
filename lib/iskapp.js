// Archivos por WhatsApp vía la misma ruta que usa la app de ISKRA (send-whatsapp), autorizada por ISKRA.
// La API pública solo manda texto/plantillas; esta ruta acepta media:{url, type, filename} (ISKRA/Gupshup descarga el link).
// Se autentica con una cuenta de ISKRA exclusiva para el panel. Credenciales SOLO en Vercel:
//   ISKRA_APP_EMAIL, ISKRA_APP_PASSWORD, ISKRA_APP_ANON (la "apikey" pública de su app), ISKRA_APP_URL (opcional)
const BASE = (process.env.ISKRA_APP_URL || "https://xglfamaaotmwulglwcui.supabase.co").replace(/\/$/, "");
let TOKEN = null; // {access, refresh, exp}

function configured(){ return !!(process.env.ISKRA_APP_EMAIL && process.env.ISKRA_APP_PASSWORD && process.env.ISKRA_APP_ANON); }

async function call(url, opts, ms){
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), ms || 20000);
  try{
    const r = await fetch(url, {...opts, signal:ctl.signal});
    const text = await r.text(); let j; try{ j = JSON.parse(text); }catch(_){ j = {raw:text.slice(0, 1000)}; }
    return {status:r.status, ok:r.ok, j};
  } finally { clearTimeout(to); }
}

async function login(force){
  if (!force && TOKEN && TOKEN.exp > Date.now() + 60e3) return TOKEN.access;
  const h = {apikey:process.env.ISKRA_APP_ANON, "content-type":"application/json"};
  let r = null;
  if (TOKEN && TOKEN.refresh && !force) r = await call(`${BASE}/auth/v1/token?grant_type=refresh_token`, {method:"POST", headers:h, body:JSON.stringify({refresh_token:TOKEN.refresh})});
  if (!r || !r.ok) r = await call(`${BASE}/auth/v1/token?grant_type=password`, {method:"POST", headers:h, body:JSON.stringify({email:process.env.ISKRA_APP_EMAIL, password:process.env.ISKRA_APP_PASSWORD})});
  if (!r.ok || !r.j.access_token) throw Object.assign(new Error("No se pudo entrar a ISKRA con la cuenta del panel: " + (r.j.error_description || r.j.msg || r.j.error || r.status)), {status:502});
  TOKEN = {access:r.j.access_token, refresh:r.j.refresh_token, exp:Date.now() + (Number(r.j.expires_in) || 3600) * 1000};
  return TOKEN.access;
}

const kindOf = type => /^image\//.test(type) ? "image" : /^audio\//.test(type) ? "audio" : /^video\//.test(type) ? "video" : "document";

// media: {url, type (mime), name}
async function sendMedia({conversation_id, text, media}){
  const body = t => JSON.stringify({conversation_id:String(conversation_id), text:String(text || ""), manual_reply:true,
    media:{url:media.url, type:t, filename:media.name || (t === "document" ? "STRIKD.pdf" : undefined)}});
  const go = async (t, again) => {
    const tok = await login(again);
    const r = await call(`${BASE}/functions/v1/send-whatsapp`, {method:"POST", headers:{authorization:"Bearer " + tok, apikey:process.env.ISKRA_APP_ANON, "content-type":"application/json"}, body:body(t)}, 30000);
    if (r.status === 401 && !again) return go(t, true); // sesión vencida: entrar de nuevo una vez
    return r;
  };
  let t = kindOf(String(media.type || "").split(";")[0]), r = await go(t, false);
  if ((!r.ok || r.j.ok === false) && t === "document"){ t = "file"; r = await go(t, false); } // por si su ruta llama "file" a los PDF
  if (!r.ok || r.j.ok === false){
    const d = r.j.debug || {};
    throw Object.assign(new Error("ISKRA no mandó el archivo: " + (r.j.error || r.j.message || d.provider_message || ("HTTP " + r.status))), {status:502, detail:{status:r.status, type:t, error:r.j.error || null, provider:d.provider_status || null}});
  }
  return {ok:true, type:t, message_id:r.j.message_id || null, warnings:r.j.warnings || []};
}

function missing(){ return ["ISKRA_APP_EMAIL", "ISKRA_APP_PASSWORD", "ISKRA_APP_ANON"].filter(k => !process.env[k]); }
module.exports = { configured, sendMedia, missing };
