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
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  // cambiar el correo con el que entra (misma cuenta: mismo historial, prospectos, puntos y Google). Cada quien el suyo; el Head el de cualquiera
  if (body.changeEmail){
    const id = String(body.changeEmail.id || who.user.id), email = String(body.changeEmail.email || "").trim().toLowerCase();
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({error:"Usuario no válido"});
    if (id !== who.user.id && !(me && me.role === "head")) return res.status(403).json({error:"Solo puedes cambiar tu propio correo"});
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({error:"Correo no válido"});
    const { data: t } = await admin.from("app_users").select("id, email, role").eq("id", id).maybeSingle();
    if (!t) return res.status(404).json({error:"No existe ese usuario"});
    if (t.role === "head" && id !== who.user.id) return res.status(403).json({error:"El correo del Head solo lo cambia el Head"});
    if (String(t.email || "").toLowerCase() === email) return res.status(200).json({ok:true, same:true});
    const oldEmail = String(t.email || "").toLowerCase();
    const { data: taken } = await admin.from("app_users").select("id").eq("email", email).maybeSingle();
    if (taken && taken.id !== id) return res.status(409).json({error:"Ese correo ya lo usa otra cuenta del equipo"});
    const { error: eu } = await admin.auth.admin.updateUserById(id, {email, email_confirm:true});
    if (eu) return res.status(/already|registered|exists/i.test(eu.message) ? 409 : 500).json({error:/already|registered|exists/i.test(eu.message) ? "Ese correo ya tiene otra cuenta" : eu.message});
    await admin.from("app_users").update({email}).eq("id", id);
    { // si sus invitaciones a meets iban a su correo anterior, ahora van al nuevo
      const { data: rd } = await admin.from("docs").select("data").eq("path", "roles/" + id).maybeSingle();
      if (rd && rd.data && String(rd.data.inviteEmail || "").toLowerCase() === oldEmail) await admin.from("docs").upsert({path:"roles/" + id, data:{...rd.data, inviteEmail:email, updatedAt:Date.now()}}); }
    await admin.from("invites").delete().eq("email", oldEmail).then(() => {}, () => {});
    return res.status(200).json({ok:true, email, before:oldEmail});
  }
  if (!me || me.role !== "head") return res.status(403).json({error:"Solo el Head puede dar de alta personas"});
  // dar de baja (o reactivar) a alguien: ya no entra, no sale en el ranking ni recibe tareas; su historial se queda
  if (body.setActive){
    const id = String(body.setActive.id || ""), on = !!body.setActive.on;
    if (!/^[0-9a-f-]{36}$/i.test(id) || id === who.user.id) return res.status(400).json({error:"Usuario no válido"});
    const { data: t } = await admin.from("app_users").select("role").eq("id", id).maybeSingle();
    if (!t) return res.status(404).json({error:"No existe ese usuario"});
    if (t.role === "head") return res.status(403).json({error:"No se puede dar de baja al Head"});
    const { error: ea } = await admin.from("app_users").update({active:on}).eq("id", id);
    if (ea) return res.status(500).json({error:ea.message});
    const { data: md } = await admin.from("docs").select("data").eq("path", "members/" + id).maybeSingle();
    await admin.from("docs").upsert({path:"members/" + id, data:{...((md && md.data) || {}), inactive:!on, ...(on ? {} : {inactiveAt:Date.now()})}});
    return res.status(200).json({ok:true});
  }
  // contraseña temporal nueva para alguien del equipo (no se puede ver la actual, solo reemplazarla)
  if (body.resetFor){
    const id = String(body.resetFor);
    if (!/^[0-9a-f-]{36}$/i.test(id) || id === who.user.id) return res.status(400).json({error:"Usuario no válido"});
    const { data: t } = await admin.from("app_users").select("role").eq("id", id).maybeSingle();
    if (!t) return res.status(404).json({error:"No existe ese usuario"});
    if (t.role === "head") return res.status(403).json({error:"No se puede cambiar la contraseña del Head"});
    const temp = "Strikd-" + crypto.randomBytes(4).toString("hex");
    const { error: eu } = await admin.auth.admin.updateUserById(id, {password:temp});
    if (eu) return res.status(500).json({error:eu.message});
    return res.status(200).json({ok:true, tempPassword:temp});
  }
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
    const { data: ex } = await admin.from("app_users").select("id, role").eq("email", email).maybeSingle();
    if (ex && (ex.role === "head" || ex.id === who.user.id)) return res.status(403).json({error:"Ese correo es del Head: no se le puede cambiar el rol desde aquí."});
    if (ex){ await admin.from("app_users").update({role, active:true, ...(name?{name}:{})}).eq("id", ex.id); await admin.from("invites").delete().eq("email", email);
      if (infl) await setInfl(ex.id);
      else { // que el organigrama diga lo mismo que la cuenta (conserva su manager y permisos)
        const { data: rd } = await admin.from("docs").select("data").eq("path", "roles/" + ex.id).maybeSingle();
        await admin.from("docs").upsert({path:"roles/" + ex.id, data:{...((rd && rd.data) || {}), role, updatedAt:Date.now()}}); } }
    return res.status(200).json({ok:true, already:true});
  }
  await setInfl(created.user.id);
  return res.status(200).json({ok:true, tempPassword:temp, id:created.user.id});
};
