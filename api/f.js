// Link corto para fotos, PDF y notas de voz que mandamos por WhatsApp: /f/<ruta> → archivo público en "wa-media"
// y (con ?t=) el link del video de los emails a influencers: /v?t=... (cuenta quién lo abre y redirige al video).
// Van en la misma función para no sumar funciones en Vercel.
const { withPg, sign } = require("../lib/google");
async function video(req, res){
  res.setHeader("cache-control", "no-store");
  const parts = String(req.query.t || "").split("."), sig = parts.pop(), [uid, vid, step] = parts, base = parts.join(".");
  let dest = "https://strikd.ai";
  try{
    await withPg(async c => {
      const cfg = ((await c.query("select data from public.docs where path='config/main'")).rows[0] || {}).data || {};
      if (cfg.mailSeq && /^https?:\/\//i.test(cfg.mailSeq.video || "")) dest = cfg.mailSeq.video;
      if (!uid || !vid || !sig || sign(base).slice(0, 16) !== sig) return;
      const path = `meets/${uid}/vip/${vid}`, now = Date.now();
      await c.query(`update public.docs set data = data || jsonb_build_object('videoClicks', coalesce((data->>'videoClicks')::int, 0) + 1, 'videoClickAt', coalesce((data->>'videoClickAt')::bigint, $2::bigint), 'videoLastAt', $2::bigint),
        version = version + 1, updated_at = now() where path = $1`, [path, now]);
      await c.query("create table if not exists public.email_clicks (id bigserial primary key, uid text, vip_id text, step int, at timestamptz default now())").catch(() => {});
      await c.query("insert into public.email_clicks (uid, vip_id, step) values ($1,$2,$3)", [uid, vid, Number(step) || 1]);
    });
  }catch(_){ /* si falla el conteo, igual abre el video */ }
  res.redirect(302, dest);
}
module.exports = (req, res) => {
  if (req.query.t !== undefined) return video(req, res);

  const base = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const p = String(req.query.path || "").split("/").filter(x => /^[A-Za-z0-9._-]+$/.test(x)).join("/");
  if (!base || !p) return res.status(404).end();
  res.setHeader("cache-control", "public, max-age=86400");
  res.redirect(302, `${base}/storage/v1/object/public/wa-media/${p}`);
};
