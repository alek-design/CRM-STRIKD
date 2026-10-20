// Sube una foto, PDF o nota de voz para mandarla por WhatsApp (ISKRA la descarga del link).
// Cualquier persona con sesión; máx. 3 MB (límite de Vercel). Bucket público "wa-media" con nombres imposibles de adivinar.
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { env, userFromReq } = require("../lib/google");
const OK = /^(image\/(jpeg|png|webp)|application\/pdf|audio\/(ogg|webm|mpeg|mp4|aac|amr)(;.*)?)$/i;
module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") return res.status(405).json({error:"POST"});
  const me = await userFromReq(req);
  if (!me) return res.status(401).json({error:"Sesión no válida"});
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  // Archivos de tareas y comentarios (fotos y PDF, hasta 20 MB): el navegador los sube directo al bucket "assets"
  // con un permiso firmado de un solo uso, así cualquier persona del equipo puede subir (no solo Head/Manager).
  if (body.sign){
    const ASSET_OK = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf)$/i;
    const t = String(body.type || "").split(";")[0].trim(), size = Number(body.size) || 0;
    const nm = String(body.name || "archivo");
    const isPdfName = /\.pdf$/i.test(nm), isImgName = /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(nm);
    const ct = ASSET_OK.test(t) ? t : isPdfName ? "application/pdf" : isImgName ? "image/" + nm.split(".").pop().toLowerCase().replace("jpg", "jpeg") : "";
    if (!ct) return res.status(400).json({error:"Solo fotos (JPG, PNG, HEIC) o PDF."});
    if (size > 20 * 1024 * 1024) return res.status(413).json({error:"El archivo pesa más de 20 MB."});
    const e = env(), sb = createClient(e.url, e.key, {auth:{persistSession:false}});
    const { data: bk } = await sb.storage.getBucket("assets");
    const allowed = bk && bk.allowed_mime_types;
    if (!bk) await sb.storage.createBucket("assets", {public:true}).catch(() => {});
    else if (Array.isArray(allowed) && allowed.length && !allowed.some(m => m === ct || (m.endsWith("/*") && ct.startsWith(m.slice(0, -1)))))
      await sb.storage.updateBucket("assets", {public:true, allowedMimeTypes:[...new Set(allowed.concat(["image/*", "application/pdf"]))], fileSizeLimit:bk.file_size_limit || null}).catch(() => {});
    const ext = (nm.match(/\.[a-z0-9]{2,5}$/i) || [""])[0].toLowerCase() || (ct === "application/pdf" ? ".pdf" : ".jpg");
    const id = crypto.randomBytes(16).toString("hex") + ext;
    const { data, error } = await sb.storage.from("assets").createSignedUploadUrl(id);
    if (error) return res.status(500).json({error:"No se pudo preparar la subida: " + error.message});
    return res.json({id, token:data.token, contentType:ct});
  }
  const type = String(body.type || ""), name = String(body.name || "archivo").replace(/[^\p{L}\p{N}._\- ]+/gu, "_").slice(0, 80);
  if (!OK.test(type)) return res.status(400).json({error:"Tipo de archivo no permitido. Usa foto (JPG/PNG), PDF o nota de voz."});
  const buf = Buffer.from(String(body.data || ""), "base64");
  if (!buf.length) return res.status(400).json({error:"Archivo vacío"});
  if (buf.length > 3 * 1024 * 1024) return res.status(413).json({error:"El archivo pesa más de 3 MB."});
  const e = env(), sb = createClient(e.url, e.key, {auth:{persistSession:false}});
  await sb.storage.createBucket("wa-media", {public:true}).catch(() => {});
  const ext = (name.match(/\.[a-z0-9]{2,5}$/i) || [""])[0] || ({"application/pdf":".pdf","image/jpeg":".jpg","image/png":".png","image/webp":".webp"}[type] || (type.includes("ogg") ? ".ogg" : type.includes("webm") ? ".webm" : type.includes("mp4") ? ".m4a" : ""));
  const path = `${new Date().toISOString().slice(0,10)}/${crypto.randomBytes(16).toString("hex")}${ext}`;
  const up = await sb.storage.from("wa-media").upload(path, buf, {contentType:type.split(";")[0], upsert:false});
  if (up.error) return res.status(500).json({error:"No se pudo subir: " + up.error.message});
  const { data } = sb.storage.from("wa-media").getPublicUrl(path);
  res.json({url:data.publicUrl, type:type.split(";")[0], name, size:buf.length});
};
