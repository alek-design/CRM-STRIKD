// Gmail para los emails automáticos a influencers (Lista de Mich) que no cerraron.
// Tokens aparte de los del calendario: key = "general" (correo del equipo) o el uid de un AM autorizado.
const { env, withPg } = require("./google");
const SCOPES = "openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly";

async function ensure(c){
  await c.query(`create table if not exists public.gmail_tokens (key text primary key, email text, refresh_token text not null, access_token text, expires_at timestamptz, connected_at timestamptz default now());
    alter table public.gmail_tokens enable row level security;
    create table if not exists public.email_log (id bigserial primary key, sender text, sender_email text, uid text, vip_id text, step int, tpl text, to_email text,
      message_id text, thread_id text, status text default 'sent', error text, at timestamptz default now());
    alter table public.email_log enable row level security;
    create index if not exists email_log_sender_at on public.email_log (sender, at);`);
}
async function tokenFor(c, key){
  await ensure(c);
  const t = (await c.query("select * from public.gmail_tokens where key=$1", [key])).rows[0]; if (!t) return null;
  if (t.access_token && t.expires_at && new Date(t.expires_at).getTime() - Date.now() > 60e3) return {token:t.access_token, email:t.email};
  const e = env();
  const r = await fetch("https://oauth2.googleapis.com/token", {method:"POST", headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({client_id:e.gid, client_secret:e.gsecret, refresh_token:t.refresh_token, grant_type:"refresh_token"})});
  const j = await r.json();
  if (!r.ok){ if (j.error === "invalid_grant") await c.query("delete from public.gmail_tokens where key=$1", [key]); return null; }
  await c.query("update public.gmail_tokens set access_token=$2, expires_at=now() + ($3 || ' seconds')::interval where key=$1", [key, j.access_token, String(j.expires_in || 3500)]);
  return {token:j.access_token, email:t.email};
}
async function save(c, key, j, email){
  await ensure(c);
  await c.query(`insert into public.gmail_tokens (key, email, refresh_token, access_token, expires_at, connected_at) values ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval, now())
    on conflict (key) do update set email=excluded.email, refresh_token=excluded.refresh_token, access_token=excluded.access_token, expires_at=excluded.expires_at, connected_at=now()`,
    [key, email, j.refresh_token, j.access_token, String(j.expires_in || 3500)]);
}
// arma el correo (texto plano UTF-8) en base64url, como lo pide la API de Gmail
const b64u = s => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encHdr = s => /^[\x20-\x7e]*$/.test(s) ? s : "=?UTF-8?B?" + Buffer.from(s, "utf8").toString("base64") + "?=";
// con html: multipart/alternative (texto + HTML), para la miniatura del video con su link
function rawMessage({from, fromName, to, subject, body, html, inReplyTo}){
  const h = [`From: ${fromName ? encHdr(fromName) + " " : ""}<${from}>`, `To: <${to}>`, `Subject: ${encHdr(subject)}`, "MIME-Version: 1.0"];
  if (inReplyTo){ h.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`); }
  const enc = t => Buffer.from(t, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  if (!html){
    h.push("Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64");
    return b64u(h.join("\r\n") + "\r\n\r\n" + enc(body));
  }
  const bd = "strikd" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  h.push(`Content-Type: multipart/alternative; boundary="${bd}"`);
  const part = (type, t) => `--${bd}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${enc(t)}\r\n`;
  return b64u(h.join("\r\n") + "\r\n\r\n" + part("text/plain", body) + part("text/html", html) + `--${bd}--`);
}
async function gapi(token, path, opts){
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, {...(opts || {}), headers:{authorization:"Bearer " + token, "content-type":"application/json"}});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ("Gmail " + r.status));
  return j;
}
async function send(token, msg, threadId){
  const j = await gapi(token, "messages/send", {method:"POST", body:JSON.stringify({raw:rawMessage(msg), ...(threadId ? {threadId} : {})})});
  let messageId = "";
  try{ const m = await gapi(token, `messages/${j.id}?format=metadata&metadataHeaders=Message-ID`); messageId = ((m.payload && m.payload.headers) || []).find(x => /^message-id$/i.test(x.name)) ? m.payload.headers.find(x => /^message-id$/i.test(x.name)).value : ""; }catch(_){}
  return {id:j.id, threadId:j.threadId, messageId};
}
// ¿contestaron en el hilo? devuelve {replied, snippet, bounce}
// ¿contestó una persona? Los avisos de "no se pudo entregar" cuentan como rebote, y las respuestas automáticas
// (fuera de la oficina, vacaciones…) no cuentan como respuesta: se sigue esperando.
const BOUNCE_RE = /undeliverable|delivery (status notification|has failed|failure|incomplete)|mail delivery (failed|subsystem|system)|address not found|no se (pudo|ha podido) entregar|no se encontr[oó] la direcci[oó]n|returned mail|failure notice|message (not delivered|blocked)|entrega fallida|could not be delivered|rejected|rechazad|bounce/i;
const AUTO_RE = /out of (the )?office|automatic reply|auto(matic)?[- ]?reply|respuesta autom[aá]tica|fuera de la oficina|estoy de vacaciones|ausente|autorespuesta|auto-?respuesta/i;
function classify(m){
  const h = n => (((m.payload && m.payload.headers) || []).find(x => x.name.toLowerCase() === n) || {}).value || "";
  const from = h("from"), subj = h("subject"), auto = h("auto-submitted"), ct = h("content-type"), txt = subj + " " + (m.snippet || "");
  if (/mailer-daemon|postmaster|mail delivery/i.test(from) || /multipart\/report/i.test(ct) || (BOUNCE_RE.test(subj) && /no-?reply|daemon|postmaster|mail/i.test(from))) return "bounce";
  if ((auto && !/^no$/i.test(auto)) || AUTO_RE.test(txt)) return "auto";
  return "human";
}
async function threadReply(token, threadId){
  const t = await gapi(token, `threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Auto-Submitted&metadataHeaders=Content-Type`);
  const ms = (t.messages || []).filter(m => !(m.labelIds || []).includes("SENT"));
  if (!ms.length) return {replied:false};
  const kinds = ms.map(classify), human = ms.filter((m, i) => kinds[i] === "human");
  if (human.length){ const last = human[human.length - 1]; return {replied:true, snippet:last.snippet || ""}; }
  if (kinds.includes("bounce")){ const b = ms[kinds.lastIndexOf("bounce")]; return {replied:true, bounce:true, snippet:b.snippet || ""}; }
  return {replied:false, auto:kinds.includes("auto")};   // solo respuesta automática: se sigue esperando
}
// nombre y firma que la cuenta tiene en Gmail (Configuración → Firma). Gmail no la agrega sola a lo que se manda por la API,
// así que la pegamos nosotros al final de cada email. Se guarda 30 min en memoria.
const SA = {};
async function sendAs(token, email){
  const c = SA[email]; if (c && Date.now() - c.at < 30 * 60e3) return c.v;
  let v = {displayName:"", signature:""};
  try{ const j = await gapi(token, `settings/sendAs/${encodeURIComponent(email)}`); v = {displayName:j.displayName || "", signature:j.signature || ""}; }
  catch(_){ try{ const l = await gapi(token, "settings/sendAs"); const d = (l.sendAs || []).find(x => x.isDefault) || (l.sendAs || [])[0] || {}; v = {displayName:d.displayName || "", signature:d.signature || ""}; }catch(__){} }
  SA[email] = {at:Date.now(), v}; return v;
}
// ---------- buzón: lo que llega a las cuentas de envío (solo lectura + responder) ----------
const hdr = (m, n) => ((((m && m.payload) || {}).headers || []).find(x => x.name.toLowerCase() === n.toLowerCase()) || {}).value || "";
// solo correos desde que arrancó la campaña de emails (Alek, 10 nov 2026: "no muestres ningún correo que haya llegado antes de hoy")
const INBOX_SINCE = Date.parse(process.env.INBOX_SINCE || "2026-11-10T05:00:00Z");   // 10 nov 2026, 00:00 Cancún
async function inbox(token, max){
  const l = await gapi(token, `messages?q=${encodeURIComponent(`in:inbox -from:me -category:promotions -category:social -from:google.com after:${Math.floor(INBOX_SINCE / 1000)}`)}&maxResults=${max || 20}`);
  const ms = await Promise.all((l.messages || []).map(m => gapi(token, `messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`).catch(() => null)));
  // nada de correos de Google (alertas de seguridad, avisos de la cuenta, etc.)
  const isGoogle = f => /@([\w-]+\.)*google\.com\b/i.test(String(f));
  return ms.filter(m => m && !isGoogle(hdr(m, "From")) && Number(m.internalDate) >= INBOX_SINCE).map(m => ({id:m.id, threadId:m.threadId, from:hdr(m, "From"), subject:hdr(m, "Subject"), at:Number(m.internalDate) || 0, snippet:m.snippet || "", unread:(m.labelIds || []).includes("UNREAD")}));
}
// lo que entró en los últimos días (incluye rebotes, que no vienen "de" una persona), con su tipo: human / bounce / auto
async function recentInbound(token, days, max){
  const l = await gapi(token, `messages?q=${encodeURIComponent(`newer_than:${days || 3}d after:${Math.floor(INBOX_SINCE / 1000)} -from:me -in:sent -in:chats`)}&maxResults=${max || 40}`);
  const ms = await Promise.all((l.messages || []).map(m => gapi(token, `messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Auto-Submitted&metadataHeaders=Content-Type&metadataHeaders=To`).catch(() => null)));
  return ms.filter(m => m && !(m.labelIds || []).includes("SENT") && Number(m.internalDate) >= INBOX_SINCE).map(m => ({id:m.id, threadId:m.threadId, from:hdr(m, "From"), subject:hdr(m, "Subject"),
    fromEmail:((hdr(m, "From").match(/<([^>]+)>/) || [, hdr(m, "From")])[1] || "").trim().toLowerCase(), at:Number(m.internalDate) || 0, snippet:m.snippet || "", kind:classify(m)}));
}
function b64d(s){ return Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); }
function bodyOf(p){
  if (!p) return "";
  if (p.mimeType === "text/plain" && p.body && p.body.data) return b64d(p.body.data);
  for (const x of p.parts || []){ const t = bodyOf(x); if (t) return t; }
  if (p.mimeType === "text/html" && p.body && p.body.data) return b64d(p.body.data).replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return "";
}
// quita lo citado ("El ... escribió:" y líneas con >) para leer solo lo nuevo
const cleanReply = t => { const L = String(t).replace(/\r/g, "").split("\n"); const i = L.findIndex(l => /^(El|On) .{5,200}(escribió|wrote):\s*$/.test(l.trim()) || /^-{2,}\s*(Original|Mensaje original)/i.test(l.trim())); return (i > 0 ? L.slice(0, i) : L).filter(l => !/^>/.test(l)).join("\n").trim(); };
async function thread(token, id){
  const t = await gapi(token, `threads/${id}?format=full`);
  return (t.messages || []).filter(m => Number(m.internalDate) >= INBOX_SINCE || (m.labelIds || []).includes("SENT")).map(m => ({id:m.id, from:hdr(m, "From"), to:hdr(m, "To"), subject:hdr(m, "Subject"), msgId:hdr(m, "Message-ID") || hdr(m, "Message-Id"), at:Number(m.internalDate) || 0,
    mine:(m.labelIds || []).includes("SENT"), text:cleanReply(bodyOf(m.payload)).slice(0, 6000)}));
}
module.exports = {recentInbound, SCOPES, ensure, tokenFor, save, send, threadReply, rawMessage, sendAs, inbox, thread};
