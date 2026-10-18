// Influencer Outreach (Mich) agenda el meet de un influencer de su lista.
// El meet queda en el journey del AM que lo propuso (la conexión y los puntos son suyos), ya validado.
// Lo hace el servidor porque Mich no puede escribir en los meets de otros.
const crypto = require("crypto");
const { withPg, userFromReq } = require("../lib/google");
const ID = /^[A-Za-z0-9_-]{1,64}$/;
module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") return res.status(405).json({error:"POST"});
  const me = await userFromReq(req);
  if (!me) return res.status(401).json({error:"Sesión no válida"});
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  try{
    const out = await withPg(async c => {
      const role = ((await c.query("select data from public.docs where path=$1", ["roles/" + me.id])).rows[0] || {}).data || {};
      if (me.role !== "head" && role.role !== "influencer") return {status:403, error:"Solo Influencer Outreach o el Head."};
      if (body.op === "stats"){ // avance de lo que consiguió Mich: pitcheados (se conectaron) y publicados
        const vips = (await c.query("select path, data from public.docs where path like 'meets/%/vip/%' and data ? 'meetId'")).rows;
        let pitched = 0, published = 0, booked = 0;
        for (const v of vips){
          const uid = v.path.split("/")[1], mid = String(v.data.meetId || ""); if (!ID.test(mid)) continue; booked++;
          const it = (await c.query("select data from public.docs where path=$1", [`meets/${uid}/items/${mid}`])).rows[0];
          const val = (await c.query("select data from public.docs where path=$1", [`validations/${mid}`])).rows[0];
          const f = (it && it.data.flow) || {};
          if ((val && val.data.status === "attended") || f.interestedAt || f.skeletonAt || f.launchedAt) pitched++;
          if (f.launchedAt) published++;
        }
        return {ok:true, booked, pitched, published};
      }
      if (body.op === "link"){
        const {uid, mid} = body; if (!ID.test(uid||"") || !ID.test(mid||"")) return {status:400, error:"Datos incompletos"};
        const it = (await c.query("select data from public.docs where path=$1", [`meets/${uid}/items/${mid}`])).rows[0];
        if (!it || it.data.source !== "mich") return {status:404, error:"No existe"};
        const patch = {link:String(body.link||""), gcalEventId:String(body.gcalEventId||""), gcalHtml:String(body.gcalHtml||""), invitedAt:Date.now()};
        await c.query("update public.docs set data = data || $2::jsonb, version=version+1, updated_at=now() where path=$1", [`meets/${uid}/items/${mid}`, JSON.stringify(patch)]);
        return {ok:true};
      }
      const [uid, vid] = String(body.vip || "").split("/");
      if (!ID.test(uid||"") || !ID.test(vid||"")) return {status:400, error:"Falta el perfil"};
      const m = body.meet || {};
      const email = String(m.email||"").trim(), meetAt = String(m.meetAt||"");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return {status:400, error:"Revisa el email."};
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(meetAt)) return {status:400, error:"Pon la fecha y hora del meet."};
      const vpath = `meets/${uid}/vip/${vid}`;
      const v = (await c.query("select data from public.docs where path=$1", [vpath])).rows[0];
      if (!v) return {status:404, error:"Ese perfil ya no está en la lista."};
      if (v.data.meetId) return {status:409, error:"Ese influencer ya tiene meet registrado."};
      const x = v.data, now = Date.now(), mid = crypto.randomBytes(10).toString("hex");
      const item = {perfil:3, prospect:x.prospect||"", profile:x.profile||"", followers:x.followers||0, notes:x.notes||"", channel:"Mich (contacto directo)",
        email, phone:String(m.phone||"").trim(), meetAt, link:"", source:"mich", bookedBy:me.id, createdAt:now, updatedAt:now, week:String(m.week||""), vipId:vid,
        guests:Array.isArray(m.guests) ? m.guests.map(String).slice(0, 10) : []};
      await c.query("insert into public.docs (path, data) values ($1,$2)", [`meets/${uid}/items/${mid}`, item]);
      await c.query("insert into public.docs (path, data) values ($1,$2) on conflict (path) do nothing", [`validations/${mid}`, {uid, week:String(m.valWeek||m.week||""), status:"valid", reason:"", decidedAt:now, perfil:3}]);
      await c.query("update public.docs set data = data || $2::jsonb, version=version+1, updated_at=now() where path=$1", [vpath, JSON.stringify({status:"agendo", statusAt:now, meetId:mid})]);
      return {ok:true, mid, uid};
    });
    res.status(out.status || 200).json(out);
  }catch(err){ res.status(500).json({error:String(err.message || err)}); }
};
