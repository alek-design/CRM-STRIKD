// /_blob/<id> → archivo de Supabase Storage (ids aleatorios de 32 caracteres).
// Redirige a un link firmado (sirve aunque el bucket no sea público); si no se puede firmar, al link público.
const { createClient } = require("@supabase/supabase-js");
module.exports = async (req, res) => {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const id = String(req.query.id || "").replace(/[^a-zA-Z0-9._-]/g, "");
  if (!base || !id) return res.status(404).end();
  if (key){
    try{
      const sb = createClient(base, key, {auth:{persistSession:false}});
      const { data } = await sb.storage.from("assets").createSignedUrl(id, 6 * 3600);
      if (data && data.signedUrl){ res.setHeader("cache-control", "private, max-age=3000"); return res.redirect(302, data.signedUrl); }
    }catch(_){ /* sigue con el link público */ }
  }
  res.setHeader("cache-control", "public, max-age=3600");
  res.redirect(302, `${base}/storage/v1/object/public/assets/${id}`);
};
