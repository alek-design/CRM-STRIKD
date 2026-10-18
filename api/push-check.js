// Revisa ISKRA cada minuto (lo llama la base de datos con pg_cron) y avisa por notificación de los mensajes nuevos.
// A quién: al dueño de la conversación; si no tiene dueño, al Head y al Creator Partnerships Manager.
const { withPg } = require("../lib/google");
const { cronKey, sendTo, init } = require("../lib/push");
const auto = require("../lib/autofollow");
const BASE = (process.env.ISKRA_API_URL || "https://xglfamaaotmwulglwcui.supabase.co/functions/v1/public-api").replace(/\/$/, "");
const arr = j => Array.isArray(j) ? j : (j && (j.data || j.items || j.conversations || j.messages || j.results)) || [];
async function get(path, ms){
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms || 10000);
  try{ const r = await fetch(BASE + path, {signal:ctl.signal, headers:{authorization:"Bearer " + process.env.ISKRA_API_KEY}}); if (!r.ok) throw new Error("ISKRA " + r.status); return await r.json(); }
  finally{ clearTimeout(t); }
}
async function post(path, payload){
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
  try{ const r = await fetch(BASE + path, {method:"POST", signal:ctl.signal, headers:{authorization:"Bearer " + process.env.ISKRA_API_KEY, "content-type":"application/json"}, body:JSON.stringify(payload)});
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error((j && (j.error || j.message)) || ("ISKRA " + r.status)); return j; }
  finally{ clearTimeout(t); }
}
module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  if (!process.env.ISKRA_API_KEY) return res.json({skip:"sin ISKRA"});
  try{
    const out = await withPg(async c => {
      await init(c);
      const key = (await cronKey(c)).key;
      if ((req.headers["x-strikd-cron"] || req.query.k) !== key) return {status:403, error:"no autorizado"};
      const list = arr(await get("/v1/conversations?limit=100"));
      const since = new Date(Date.now() - 15*60e3).toISOString();
      try{ arr(await get(`/v1/messages/whatsapp?direction=inbound&limit=50&from=${encodeURIComponent(since)}&since=${encodeURIComponent(since)}`, 4000)).forEach(m => {
        const id = String(m.conversation_id || ""); if (!id) return;
        let cv = list.find(x => String(x.id) === id); if (!cv){ cv = {id, contact_phone:m.phone || m.from || "", contact_name:m.contact_name || null}; list.push(cv); }
        const at = m.created_at || m.sent_at; if (!cv.last_message_at || Date.parse(at) >= Date.parse(cv.last_message_at)){ cv.last_message_at = at; cv.last_message_text = m.text || m.body || cv.last_message_text; }
        cv.unread_count = Math.max(1, Number(cv.unread_count || 0));
      }); }catch(_){}
      const ids = list.map(x => String(x.id));
      const seen = {}; (await c.query("select * from public.push_seen where conversation_id = any($1)", [ids])).rows.forEach(r => seen[r.conversation_id] = r);
      const first = !(await c.query("select 1 from public.push_seen limit 1")).rows[0];
      const owners = {}; (await c.query("select conversation_id, owner, discarded_at from public.iskra_owner where conversation_id = any($1)", [ids]).catch(() => ({rows:[]}))).rows.forEach(r => owners[r.conversation_id] = r);
      const leadRows = (await c.query("select id, role from public.app_users where role in ('head','manager') and active")).rows;
      const leads = leadRows.map(r => r.id), headId = (leadRows.find(r => r.role === "head") || leadRows[0] || {}).id || null;
      await auto.ensure(c);
      const origin = "https://" + (req.headers["x-forwarded-host"] || req.headers.host || "growth.strikd.ai");
      const autos = [];
      let sent = 0, n = 0, dest = 0; const errs = [];
      const isLead = new Set(leads);
      const unreadFor = u => list.filter(cv => Number(cv.unread_count || 0) > 0 && !(owners[String(cv.id)] && owners[String(cv.id)].discarded_at)
        && (isLead.has(u) || (owners[String(cv.id)] && owners[String(cv.id)].owner === u))).length;
      for (const cv of list){
        const id = String(cv.id), at = cv.last_message_at; if (!at) continue;
        const prev = seen[id] && seen[id].last_at ? new Date(seen[id].last_at).getTime() : 0, t = Date.parse(at);
        if (t <= prev) continue;
        await c.query("insert into public.push_seen (conversation_id, last_at) values ($1,$2) on conflict (conversation_id) do update set last_at=excluded.last_at", [id, at]);
        if (first || !(Number(cv.unread_count || 0) > 0) || Date.now() - t > 30*60e3) continue; // solo lo nuevo que escribió el prospecto
        const o = owners[id]; if (o && o.discarded_at && new Date(o.discarded_at).getTime() > t) continue;
        // segundo intento automático: si lo que llegó fue la respuesta automática de su WhatsApp, mandamos la plantilla A/B/C
        try{ await auto.markReplied(c, id, t);
          const r = await auto.maybeAuto(c, cv, {get, post, owner:(o && o.owner) || headId, origin});
          if (r){ autos.push(r); if (!r.error) continue; } // era un bot: no avisamos
        }catch(e){ autos.push({conv:id, error:String(e.message || e)}); }
        // al dueño y siempre al Head y al Manager (ellos ven todas las conversaciones)
        const to = [...new Set([...(o && o.owner ? [o.owner] : []), ...leads])]; if (!to.length) continue;
        const name = cv.contact_name || (cv.lead && cv.lead.full_name) || cv.contact_phone || "WhatsApp";
        n++; dest += to.length;
        for (const u of to){ // cada quien con su número en el ícono: conversaciones sin leer que le tocan
          const badge = unreadFor(u);
          sent += await sendTo(c, [u], {title:name, body:String(cv.last_message_text || "Mensaje nuevo").slice(0, 160), url:"/?tab=msgs&conv=" + encodeURIComponent(id), tag:"conv-" + id, badge});
          errs.push(...(sendTo.lastErrors || []));
        }
      }
      return {ok:true, revisadas:list.length, nuevas:n, personas:dest, enviadas:sent, primera_vez:first, ...(autos.length ? {automaticos:autos} : {}), ...(errs.length ? {errores:errs.slice(0,3)} : {})};
    });
    res.status(out.status || 200).json(out);
  }catch(err){ res.status(500).json({error:String(err.message || err)}); }
};
