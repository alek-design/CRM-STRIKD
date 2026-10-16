// Datos públicos para el navegador (la anon key está hecha para ir en el cliente; RLS protege los datos).
module.exports = (req, res) => {
  res.setHeader("cache-control", "no-store");
  res.status(200).json({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "",
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || ""
  });
};
