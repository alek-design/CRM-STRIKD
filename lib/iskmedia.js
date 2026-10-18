// Archivos para WhatsApp (ISKRA los descarga de un link público).
//  · Los PDF/fotos de plantillas viven en el bucket "assets" y se sirven por /_blob/<id> (redirección y sin extensión):
//    WhatsApp a veces no los acepta así. Los copiamos una vez al bucket público "wa-media" con extensión y tipo correctos.
//  · El cuerpo para ISKRA lleva el archivo en los formatos más comunes (no tenemos su especificación de adjuntos).
const { createClient } = require("@supabase/supabase-js");
const { env } = require("./google");
const COPY = {};
const EXT = {"application/pdf":".pdf", "image/jpeg":".jpg", "image/png":".png", "image/webp":".webp", "audio/ogg":".ogg", "audio/mpeg":".mp3", "audio/mp4":".m4a", "audio/aac":".aac", "audio/webm":".webm"};
const TYPE_OF_EXT = {pdf:"application/pdf", jpg:"image/jpeg", jpeg:"image/jpeg", png:"image/png", webp:"image/webp", ogg:"audio/ogg", mp3:"audio/mpeg", m4a:"audio/mp4", aac:"audio/aac", webm:"audio/webm"};

async function publicMedia(media){
  const m = String(media.url || "").match(/\/_blob\/([A-Za-z0-9._-]+)/);
  if (!m) return media;
  const id = m[1];
  if (COPY[id]) return {...media, ...COPY[id]};
  const e = env(), sb = createClient(e.url, e.key, {auth:{persistSession:false}});
  const dl = await sb.storage.from("assets").download(id);
  if (dl.error) throw new Error("No se encontró el archivo de la plantilla: " + dl.error.message);
  const buf = Buffer.from(await dl.data.arrayBuffer());
  const byName = TYPE_OF_EXT[String(media.name || "").toLowerCase().split(".").pop()];
  const type = byName || (dl.data.type && dl.data.type !== "application/octet-stream" ? dl.data.type.split(";")[0] : "") || media.type || "application/pdf";
  await sb.storage.createBucket("wa-media", {public:true}).catch(() => {});
  const path = `tpl/${id}${EXT[type] || ""}`;
  const up = await sb.storage.from("wa-media").upload(path, buf, {contentType:type, upsert:true});
  if (up.error) throw new Error("No se pudo preparar el archivo: " + up.error.message);
  const url = sb.storage.from("wa-media").getPublicUrl(path).data.publicUrl;
  COPY[id] = {url, type};
  return {...media, url, type};
}

function mediaPayload(media, text){
  const type = String(media.type || "").split(";")[0];
  const kind = /^image\//.test(type) ? "image" : /^audio\//.test(type) ? "audio" : "document";
  const filename = media.name || (kind === "document" ? "STRIKD.pdf" : undefined);
  const caption = kind === "audio" ? undefined : (text || undefined);
  const obj = {link:media.url, url:media.url, filename: kind === "document" ? filename : undefined, caption};
  return {
    type:kind, media_url:media.url, media_type:type, mime_type:type, filename, caption,
    media:{url:media.url, type:kind, mime_type:type, filename, caption},
    attachments:[{url:media.url, type:kind, mime_type:type, filename}],
    [kind]:obj,
  };
}

module.exports = {publicMedia, mediaPayload};
