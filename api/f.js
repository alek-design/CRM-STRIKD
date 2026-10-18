// Link corto para fotos, PDF y notas de voz que mandamos por WhatsApp: /f/<ruta> → archivo público en "wa-media"
module.exports = (req, res) => {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const p = String(req.query.path || "").split("/").filter(x => /^[A-Za-z0-9._-]+$/.test(x)).join("/");
  if (!base || !p) return res.status(404).end();
  res.setHeader("cache-control", "public, max-age=86400");
  res.redirect(302, `${base}/storage/v1/object/public/wa-media/${p}`);
};
