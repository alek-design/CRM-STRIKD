// /_blob/<id> → archivo público en Supabase Storage (ids aleatorios de 32 caracteres)
module.exports = (req, res) => {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const id = String(req.query.id || "").replace(/[^a-zA-Z0-9._-]/g, "");
  if (!base || !id) return res.status(404).end();
  res.setHeader("cache-control", "public, max-age=3600");
  res.redirect(302, `${base}/storage/v1/object/public/assets/${id}`);
};
