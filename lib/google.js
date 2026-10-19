// Utilidades del servidor para Google Calendar: tokens por usuario guardados en Postgres (solo el servidor los ve).
const crypto = require("crypto");
const { Client } = require("pg");
const { createClient } = require("@supabase/supabase-js");

const env = () => ({
  url: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  pg: process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL || process.env.DATABASE_URL,
  gid: process.env.GOOGLE_CLIENT_ID, gsecret: process.env.GOOGLE_CLIENT_SECRET
});
async function withPg(fn){
  const c = new Client({connectionString: env().pg.replace(/[?&]sslmode=[^&]*/,""), ssl:{rejectUnauthorized:false}});
  await c.connect();
  try{
    await c.query(`create table if not exists public.google_tokens (
      user_id uuid primary key, email text, refresh_token text not null, access_token text, expires_at timestamptz, connected_at timestamptz default now());
      alter table public.google_tokens enable row level security;
      create table if not exists public.google_extra_tokens (
      user_id uuid not null, email text not null, refresh_token text not null, access_token text, expires_at timestamptz, connected_at timestamptz default now(),
      primary key (user_id, email));
      alter table public.google_extra_tokens enable row level security;`);
    return await fn(c);
  } finally { await c.end().catch(()=>{}); }
}
async function userFromReq(req){
  const e = env(); const admin = createClient(e.url, e.key, {auth:{persistSession:false}});
  const token = (req.headers.authorization || "").replace(/^Bearer /, "") || (req.query && req.query.token) || "";
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  if (!data || !data.user) return null;
  const { data: me } = await admin.from("app_users").select("id,role,email,name").eq("id", data.user.id).maybeSingle();
  return me && me.role !== "none" ? me : null;
}
const sign = (s) => crypto.createHmac("sha256", env().key).update(s).digest("base64url");
const makeState = (uid) => { const s = `${uid}.${Date.now()}`; return `${s}.${sign(s)}`; };
function readState(st){
  const [uid, ts, sig] = String(st||"").split(".");
  if (!uid || !ts || sig !== sign(`${uid}.${ts}`) || Date.now() - Number(ts) > 15*60e3) return null;
  return uid;
}
const redirectUri = (req) => `https://${req.headers["x-forwarded-host"] || req.headers.host}/api/google/callback`;

// Cuenta extra conectada directo (p. ej. el Google de otro trabajo): su propio token, para leer su calendario completo
async function accessTokenForExtra(uid, email){ return accessTokenFor(uid, String(email || "").toLowerCase()); }
async function accessTokenFor(uid, extraEmail){
  const T = extraEmail ? "public.google_extra_tokens" : "public.google_tokens", W = extraEmail ? "user_id = $1 and email = $4" : "user_id = $1";
  return withPg(async (c) => {
    const r = await c.query(`select * from ${T} where ${W.replace("$4", "$2")}`, extraEmail ? [uid, extraEmail] : [uid]);
    const t = r.rows[0]; if (!t) return null;
    if (t.access_token && t.expires_at && new Date(t.expires_at).getTime() - Date.now() > 60e3) return t.access_token;
    const e = env();
    const resp = await fetch("https://oauth2.googleapis.com/token", {method:"POST", headers:{"content-type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({client_id:e.gid, client_secret:e.gsecret, refresh_token:t.refresh_token, grant_type:"refresh_token"})});
    const j = await resp.json();
    const xp = extraEmail ? [extraEmail] : [];
    if (!resp.ok){ if (j.error === "invalid_grant") await c.query(`delete from ${T} where ${W.replace("$4", "$2")}`, [uid, ...xp]); return null; }
    await c.query(`update ${T} set access_token=$2, expires_at=now() + ($3 || ' seconds')::interval where ${W}`, [uid, j.access_token, String(j.expires_in || 3500), ...xp]);
    return j.access_token;
  });
}
module.exports = { env, withPg, userFromReq, makeState, readState, redirectUri, accessTokenFor, accessTokenForExtra };
