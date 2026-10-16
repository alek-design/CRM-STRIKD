// Configuración inicial desde la página: crea las tablas, carga los datos y crea al Head.
// Solo funciona mientras no exista un Head; después responde "ya configurado".
const fs = require("fs"), path = require("path");
const { Client } = require("pg");
const { createClient } = require("@supabase/supabase-js");
function env(){
  return {
    url: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
    pg: process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL || process.env.DATABASE_URL
  };
}
async function hasHead(pgc){
  const t = await pgc.query("select to_regclass('public.app_users') as t");
  if (!t.rows[0].t) return false;
  const r = await pgc.query("select count(*)::int n from public.app_users where role = 'head'");
  return r.rows[0].n > 0;
}
function pgClient(conn){ return new Client({connectionString: conn.replace(/[?&]sslmode=[^&]*/,""), ssl:{rejectUnauthorized:false}}); }
module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  const e = env();
  if (!e.url || !e.key || !e.pg) return res.status(500).json({error:"Faltan variables de Supabase en Vercel (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, POSTGRES_URL)."});
  const pgc = pgClient(e.pg);
  try{
    await pgc.connect();
    const done = await hasHead(pgc);
    if (req.method === "GET") return res.status(200).json({needsSetup: !done});
    if (req.method !== "POST") return res.status(405).json({error:"Método no permitido"});
    if (done) return res.status(409).json({error:"Ya está configurado. Entra con tu correo."});
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const email = String(body.email || "").trim().toLowerCase(), password = String(body.password || ""), name = String(body.name || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({error:"Correo no válido"});
    if (password.length < 8) return res.status(400).json({error:"La contraseña necesita al menos 8 caracteres"});
    const dir = path.join(process.cwd(), "supabase");
    await pgc.query(fs.readFileSync(path.join(dir, "schema.sql"), "utf8"));
    await pgc.query(fs.readFileSync(path.join(dir, "seed.sql"), "utf8"));
    const admin = createClient(e.url, e.key, {auth:{persistSession:false}});
    const { error } = await admin.auth.admin.createUser({email, password, email_confirm:true, user_metadata:{name}});
    if (error && !/already/i.test(error.message)) return res.status(500).json({error:error.message});
    if (error){ // ya existía: lo hacemos Head
      await pgc.query("insert into public.app_users (id,email,name,role) select id, email, $2, 'head' from auth.users where lower(email)=$1 on conflict (id) do update set role='head'", [email, name || email.split("@")[0]]);
    }
    return res.status(200).json({ok:true});
  }catch(err){
    return res.status(500).json({error:"No se pudo configurar: " + (err.message || err)});
  }finally{ try{ await pgc.end(); }catch(_){} }
};
