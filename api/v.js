// Link del video de los emails a influencers: cuenta quién lo abre y redirige al video (config/main.mailSeq.video).
// t = "<uid>.<vipId>.<paso>.<firma>" (firma HMAC; no se puede inventar un link para contar clics falsos).
const { withPg, sign } = require("../lib/google");
module.exports = async (req, res) => {
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
};
