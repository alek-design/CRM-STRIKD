// El Head invita a alguien por correo con su rol. Usa la service role key, que solo vive en el servidor.
const { createClient } = require("@supabase/supabase-js");
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({error:"Método no permitido"});
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return res.status(500).json({error:"Falta SUPABASE_SERVICE_ROLE_KEY en Vercel"});
  const admin = createClient(url, key, {auth:{persistSession:false}});
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  const { data: who } = await admin.auth.getUser(token);
  if (!who || !who.user) return res.status(401).json({error:"Sesión no válida"});
  const { data: me } = await admin.from("app_users").select("role").eq("id", who.user.id).maybeSingle();
  if (!me || me.role !== "head") return res.status(403).json({error:"Solo el Head puede invitar"});
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const email = String(body.email || "").trim().toLowerCase(), name = String(body.name || "").trim(), role = body.role === "manager" ? "manager" : "am";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({error:"Correo no válido"});
  const { error: e1 } = await admin.from("invites").upsert({email, name, role, invited_by:who.user.id});
  if (e1) return res.status(500).json({error:"No se pudo guardar la invitación"});
  const origin = req.headers.origin || `https://${req.headers.host}`;
  const { error } = await admin.auth.admin.inviteUserByEmail(email, {redirectTo: origin, data:{name}});
  if (error && !/already/i.test(error.message)) return res.status(500).json({error:error.message});
  return res.status(200).json({ok:true, already: !!error});
};
