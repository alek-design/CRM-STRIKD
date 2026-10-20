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
function rawMessage({from, fromName, to, subject, body, inReplyTo}){
  const h = [`From: ${fromName ? encHdr(fromName) + " " : ""}<${from}>`, `To: <${to}>`, `Subject: ${encHdr(subject)}`, "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"];
  if (inReplyTo){ h.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`); }
  const b = Buffer.from(body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return b64u(h.join("\r\n") + "\r\n\r\n" + b);
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
async function threadReply(token, threadId){
  const t = await gapi(token, `threads/${threadId}?format=metadata&metadataHeaders=From`);
  const ms = (t.messages || []).filter(m => !(m.labelIds || []).includes("SENT"));
  if (!ms.length) return {replied:false};
  const last = ms[ms.length - 1], from = (((last.payload && last.payload.headers) || []).find(x => /^from$/i.test(x.name)) || {}).value || "";
  return {replied:true, snippet:last.snippet || "", bounce:/mailer-daemon|postmaster/i.test(from)};
}
module.exports = {SCOPES, ensure, tokenFor, save, send, threadReply, rawMessage};
