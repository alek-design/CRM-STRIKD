// El Head da de alta a alguien de su equipo: crea su cuenta con una contraseña temporal y su rol.
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({error:"Método no permitido"});
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return res.status(500).json({error:"Falta SUPABASE_SERVICE_ROLE_KEY en Vercel"});
  const admin = createClient(url, key, {auth:{persistSession:false}});
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  const { data: who } = await admin.auth.getUser(token);
  if (!who || !who.user) return res.status(401).json({error:"Sesión no válida"});
  const { data: me } = await admin.from("app_users").select("role").eq("id", who.user.id).maybeSingle();
  if (!me || me.role !== "head") return res.status(403).json({error:"Solo el Head puede dar de alta personas"});
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const email = String(body.email || "").trim().toLowerCase(), name = String(body.name || "").trim(), role = body.role === "manager" ? "manager" : "am", infl = body.role === "influencer";
  const setInfl = async id => { if (infl && id) await admin.from("docs").upsert({path:"roles/" + id, data:{role:"influencer", updatedAt:Date.now()}}); };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({error:"Correo no válido"});
  const { error: e1 } = await admin.from("invites").upsert({email, name, role, invited_by:who.user.id});
  if (e1) return res.status(500).json({error:"No se pudo guardar el alta"});
  const temp = "Strikd-" + crypto.randomBytes(4).toString("hex");
  const { data: created, error } = await admin.auth.admin.createUser({email, password:temp, email_confirm:true, user_metadata:{name}});
  if (error){
    if (!/already/i.test(error.message)) return res.status(500).json({error:error.message});
    // ya tenía cuenta: solo cambiamos su rol
    const { data: ex } = await admin.from("app_users").select("id").eq("email", email).maybeSingle();
    if (ex){ await admin.from("app_users").update({role, active:true, ...(name?{name}:{})}).eq("id", ex.id); await admin.from("invites").delete().eq("email", email); await setInfl(ex.id); }
    return res.status(200).json({ok:true, already:true});
  }
  await setInfl(created.user.id);
  return res.status(200).json({ok:true, tempPassword:temp, id:created.user.id});
};
