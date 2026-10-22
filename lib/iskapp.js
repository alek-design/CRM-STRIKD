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

// Fotos/PDF/audios de una conversación (la API pública no los regresa). Lee la tabla de mensajes de la app con la cuenta del panel
// y saca cualquier link de archivo (Gupshup filemanager, storage chat-media o con extensión de archivo), sin depender de nombres de campos.
const FILE_RX = /^https?:\/\/\S+$/i;
function scanMedia(o){
  const out = []; const seen = new Set();
  const walk = (v, key, d) => { if (d > 4 || v == null) return;
    if (typeof v === "string"){ if (FILE_RX.test(v) && (/filemanager\.gupshup\.io|\/chat-media\/|\/wa-media\//i.test(v) || /\.(jpe?g|png|webp|gif|pdf|ogg|opus|mp3|m4a|aac|amr|mp4)(\?|$)/i.test(v)) && !seen.has(v)){ seen.add(v); out.push({url:v, key}); } return; }
    if (Array.isArray(v)) return v.forEach(x => walk(x, key, d+1));
    if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k, d+1); };
  walk(o, "", 0); return out;
}
async function convRows(conversation_id, limit){
  const q = `${BASE}/rest/v1/messages?conversation_id=eq.${encodeURIComponent(conversation_id)}&select=*&order=created_at.desc&limit=${limit || 80}`;
  const go = async again => { const tok = await login(again);
    const r = await call(q, {method:"GET", headers:{authorization:"Bearer " + tok, apikey:process.env.ISKRA_APP_ANON}}, 12000);
    if (r.status === 401 && !again) return go(true); return r; };
  const r = await go(false);
  if (!r.ok || !Array.isArray(r.j)) throw Object.assign(new Error("No se pudieron leer los mensajes de ISKRA (" + r.status + ")"), {status:502, detail:r.j});
  return r.j;
}
// dirección del mensaje solo si hay un campo claro (si no, se usa la API pública)
function dirOf(m){
  const v = m.direction ?? m.message_direction ?? m.sender_type ?? m.from_type ?? m.author_type ?? m.role;
  if (typeof v === "string" && v){ if (/^(in|inbound|incoming|received|lead|contact|customer|user)$/i.test(v)) return "in"; if (/^(out|outbound|outgoing|sent|agent|bot|system|business|assistant|api|operator)$/i.test(v)) return "out"; }
  for (const k of ["from_me", "is_from_me", "is_outbound", "outbound", "fromMe"]) if (typeof m[k] === "boolean") return m[k] ? "out" : "in";
  if (typeof m.is_inbound === "boolean") return m.is_inbound ? "in" : "out";
  return "";
}
// mensajes listos para el chat (lo más nuevo primero), con su archivo. null si no se reconoce el formato
async function convMessages(conversation_id){
  const rows = await convRows(conversation_id, 80);
  if (!rows.length) return {data:[], debug:{rows:0}};
  if (!rows.every(m => dirOf(m))) return null;
  const txt = m => [m.text, m.content, m.body, m.message, m.caption, m.message_text].find(x => typeof x === "string" && x.trim()) || "";
  const data = rows.map(m => { const f = scanMedia(m)[0];
    const type = String(m.media_type || m.message_type || (m.media && m.media.type) || m.type || "");
    return {id:m.id, text:txt(m), direction:dirOf(m) === "in" ? "inbound" : "outbound", created_at:m.created_at || m.sent_at || m.timestamp, status:m.status || m.delivery_status || "",
      ...(f ? {media_url:f.url, media_type:/text/i.test(type) ? "" : type, filename:(m.media && (m.media.filename || m.media.name)) || m.filename || m.file_name || ""} : {})}; });
  return {data, debug:{rows:rows.length, keys:Object.keys(rows[0]).slice(0, 40), sample:JSON.stringify(rows.find(r => scanMedia(r).length) || rows[0]).slice(0, 900)}};
}
async function convMedia(conversation_id){
  const rows = await convRows(conversation_id, 80);
  const items = [];
  for (const m of rows){
    const found = scanMedia(m); if (!found.length) continue;
    const at = Date.parse(m.created_at || m.sent_at || m.timestamp || "") || 0;
    const type = String(m.media_type || m.message_type || m.type || (m.media && m.media.type) || "");
    const dirTxt = String(m.direction || m.from_type || m.sender_type || (m.from_me === true ? "out" : m.from_me === false ? "in" : "") || "");
    const name = (m.media && (m.media.filename || m.media.name)) || m.filename || m.file_name || "";
    found.slice(0, 1).forEach(f => items.push({id:m.id || null, at, url:f.url, type, name, dir:/^(in|inbound|incoming|received|lead|contact)/i.test(dirTxt) ? "in" : dirTxt ? "out" : ""}));
  }
  return items;
}

// diagnóstico (solo Head): ¿en qué tabla de la app de ISKRA viven las copies del Copy Studio y las plantillas "24h reply"?
async function findCopies(q){
  const tables = ["chat_copies","copies","campaign_copies","copy_studio","copy_texts","copy_variants","copy_groups","copy_folders","quick_replies","snippets","library_snippets",
    "templates","template_groups","whatsapp_templates","wa_templates","message_templates","campaign_texts","campaign_templates","reply_templates","canned_responses"];
  const tok = await login(false), out = [], needle = String(q || "ventana").toLowerCase();
  for (const t of tables){
    const r = await call(`${BASE}/rest/v1/${t}?select=*&limit=200`, {method:"GET", headers:{authorization:"Bearer " + tok, apikey:process.env.ISKRA_APP_ANON}}, 10000).catch(e => ({status:0, j:{error:String(e.message)}}));
    if (!Array.isArray(r.j)){ out.push({tabla:t, status:r.status, error:(r.j && (r.j.message || r.j.error || r.j.code)) || ""}); continue; }
    const hits = r.j.filter(x => JSON.stringify(x).toLowerCase().includes(needle));
    out.push({tabla:t, status:r.status, filas:r.j.length, campos:r.j[0] ? Object.keys(r.j[0]).slice(0, 30) : [], coincidencias:hits.length,
      ejemplos:hits.slice(0, 5).map(x => JSON.stringify(x).slice(0, 700))});
  }
  return out;
}
function missing(){ return ["ISKRA_APP_EMAIL", "ISKRA_APP_PASSWORD", "ISKRA_APP_ANON"].filter(k => !process.env[k]); }
module.exports = { configured, sendMedia, missing, convMedia, convMessages, findCopies };
