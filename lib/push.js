// Notificaciones: llaves VAPID guardadas en la base (solo el servidor), suscripciones por persona y envío.
const crypto = require("crypto");
const webpush = require("web-push");
const SQL = `
create table if not exists public.app_secrets (key text primary key, value jsonb not null, created_at timestamptz default now());
alter table public.app_secrets enable row level security;
create table if not exists public.push_subs (endpoint text primary key, user_id uuid not null, sub jsonb not null, ua text, created_at timestamptz default now(), last_ok timestamptz);
alter table public.push_subs enable row level security;
create table if not exists public.push_seen (conversation_id text primary key, last_at timestamptz);
alter table public.push_seen enable row level security;`;
let ready = false;
async function init(c){ if (!ready){ await c.query(SQL); ready = true; } }
async function secret(c, key, make){
  await init(c);
  const r = await c.query("select value from public.app_secrets where key=$1", [key]);
  if (r.rows[0]) return r.rows[0].value;
  const v = make();
  await c.query("insert into public.app_secrets (key, value) values ($1,$2) on conflict (key) do nothing", [key, JSON.stringify(v)]);
  return (await c.query("select value from public.app_secrets where key=$1", [key])).rows[0].value;
}
const vapid = c => secret(c, "vapid", () => webpush.generateVAPIDKeys());
const cronKey = c => secret(c, "cron", () => ({key: crypto.randomBytes(24).toString("hex")}));
async function sendTo(c, userIds, payload){
  const keys = await vapid(c);
  webpush.setVapidDetails("mailto:growth@strikd.ai", keys.publicKey, keys.privateKey);
  const subs = (await c.query("select * from public.push_subs where user_id = any($1)", [userIds])).rows;
  let ok = 0; sendTo.lastErrors = [];
  await Promise.all(subs.map(async s => {
    try{ await webpush.sendNotification(s.sub, JSON.stringify(payload), {TTL: 3600, urgency: "high"}); ok++; await c.query("update public.push_subs set last_ok=now() where endpoint=$1", [s.endpoint]); }
    catch(e){ sendTo.lastErrors.push(`${e.statusCode || ""} ${String(e.body || e.message || "").slice(0, 120)}`); if (e.statusCode === 404 || e.statusCode === 410) await c.query("delete from public.push_subs where endpoint=$1", [s.endpoint]); }
  }));
  return ok;
}
module.exports = { init, vapid, cronKey, sendTo };
