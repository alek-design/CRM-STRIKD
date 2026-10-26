// Revisa ISKRA cada minuto (lo llama la base de datos con pg_cron) y avisa por notificación de los mensajes nuevos.
// A quién: al dueño de la conversación; si no tiene dueño, al Head y al Creator Partnerships Manager.
const { withPg } = require("../lib/google");
const { cronKey, sendTo, init } = require("../lib/push");
const auto = require("../lib/autofollow");
const { migrate } = require("../lib/migrate");
const report = require("../lib/report");
const taskrules = require("../lib/taskrules");
const reminders = require("../lib/reminders");
const resptime = require("../lib/resptime");
const emailauto = require("../lib/emailauto");
const weekfreeze = require("../lib/weekfreeze");
const aireply = require("../lib/aireply");
const stall = require("../lib/stallfollow");
const meetremind = require("../lib/meetremind");
const perfilresp = require("../lib/perfilresp");
const vipimport = require("../lib/vipimport");
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
      // reporte diario de las 9 pm (una vez por día y por persona)
      let reporte = null; try{ reporte = await report.maybeSend(c); }catch(e){ reporte = {error:String(e.message || e)}; }
      // tareas que se repiten cada semana
      let semanales = null; try{ await migrate(c).catch(() => {}); semanales = await taskrules.run(c); }catch(e){ semanales = {error:String(e.message || e)}; }
      let recordatorios = null; try{ recordatorios = await reminders.run(c); }catch(e){ recordatorios = {error:String(e.message || e)}; }
      let respuesta = null; try{ respuesta = await resptime.run(c, get); }catch(e){ respuesta = {error:String(e.message || e)}; }
      let emails = null; try{ emails = await emailauto.run(c); }catch(e){ emails = {error:String(e.message || e)}; }
      let semana = null; try{ semana = await weekfreeze.run(c); }catch(e){ semana = {error:String(e.message || e)}; }
      const list = arr(await get("/v1/conversations?limit=100"));
      const since = new Date(Date.now() - 30*60e3).toISOString();
      // último mensaje QUE ESCRIBIÓ EL PROSPECTO por conversación: solo eso avisa (no lo que manda el equipo)
      const inboundAt = {}; let inboundOk = false;
      try{ arr(await get(`/v1/messages/whatsapp?direction=inbound&limit=50&from=${encodeURIComponent(since)}&since=${encodeURIComponent(since)}`, 4000)).forEach(m => {
        const id = String(m.conversation_id || ""); if (!id) return;
        { const a = Date.parse(m.created_at || m.sent_at || 0) || 0; if (a > (inboundAt[id] || 0)) inboundAt[id] = a; }
        let cv = list.find(x => String(x.id) === id); if (!cv){ cv = {id, contact_phone:m.phone || m.from || "", contact_name:m.contact_name || null}; list.push(cv); }
        const at = m.created_at || m.sent_at; if (!cv.last_message_at || Date.parse(at) >= Date.parse(cv.last_message_at)){ cv.last_message_at = at; cv.last_message_text = m.text || m.body || cv.last_message_text; }
        cv.unread_count = Math.max(1, Number(cv.unread_count || 0));
      }); inboundOk = true; }catch(_){}
      const ids = list.map(x => String(x.id));
      // seguimiento "Dejó de responder" a chats 🔥 (2 h sin respuesta, de 9 am a 9 pm)
      let seguimiento = null; try{ await migrate(c).catch(() => {}); const names = {}; list.forEach(cv => { names[String(cv.id)] = cv.contact_name || (cv.lead && cv.lead.full_name) || ""; });
        seguimiento = await stall.run(c, {get, post, origin:"https://" + (req.headers["x-forwarded-host"] || req.headers.host || "growth.strikd.ai"), names}); }catch(e){ seguimiento = {error:String(e.message || e)}; }
      // recordatorio por WhatsApp 30 min antes a meets agendados desde un chat de ISKRA
      let importacion = null; try{ importacion = await vipimport.run(c); }catch(e){ importacion = {error:String(e.message || e)}; }
      let responsables = null; try{ responsables = await perfilresp.run(c); }catch(e){ responsables = {error:String(e.message || e)}; }
      let recordatorio_meet = null; try{ recordatorio_meet = await meetremind.run(c, {get, post}); }catch(e){ recordatorio_meet = {error:String(e.message || e)}; }
      let respuesta_recordatorio = null; try{ respuesta_recordatorio = await meetremind.watch(c, {get}); }catch(e){ respuesta_recordatorio = {error:String(e.message || e)}; }
      let confirmacion_meet = null; try{ confirmacion_meet = await meetremind.confirm(c, {post}); }catch(e){ confirmacion_meet = {error:String(e.message || e)}; }
      const seen = {}; (await c.query("select * from public.push_seen where conversation_id = any($1)", [ids])).rows.forEach(r => seen[r.conversation_id] = r);
      const first = !(await c.query("select 1 from public.push_seen limit 1")).rows[0];
      const owners = {}; (await c.query("select conversation_id, owner, discarded_at, noreply_at from public.iskra_owner where conversation_id = any($1)", [ids]).catch(() => ({rows:[]}))).rows.forEach(r => owners[r.conversation_id] = r);
      const leadRows = (await c.query("select id, role from public.app_users where role in ('head','manager') and active")).rows;
      const leads = leadRows.map(r => r.id), headId = (leadRows.find(r => r.role === "head") || leadRows[0] || {}).id || null;
      await auto.ensure(c);
      await migrate(c).catch(() => {});
      const origin = "https://" + (req.headers["x-forwarded-host"] || req.headers.host || "growth.strikd.ai");
      const autos = [], ais = []; let aiN = 0;
      let sent = 0, n = 0, dest = 0; const errs = [];
      // bandeja única: Rafa recibe aviso de todas las conversaciones (config/main.iskInbox, encendido por defecto)
      const cfgM = ((await c.query("select data from public.docs where path='config/main'")).rows[0] || {}).data || {};
      const inboxMail = cfgM.iskInbox === false ? null : (cfgM.iskInboxEmail || (cfgM.perfilInvite || {1:"partners@strikd.ai"})[1] || "partners@strikd.ai");
      const inboxId = inboxMail ? ((await c.query("select id from public.app_users where lower(email)=lower($1) and coalesce(active,true)", [String(inboxMail)]).catch(() => ({rows:[]}))).rows[0] || {}).id || null : null;
      const isLead = new Set([...leads, ...(inboxId ? [inboxId] : [])]);
      const nrDone = cv => { const o = owners[String(cv.id)]; return !!(o && o.noreply_at && new Date(o.noreply_at).getTime() >= (Date.parse(cv.last_message_at || "") || 0)); };
      const unreadFor = u => list.filter(cv => Number(cv.unread_count || 0) > 0 && !nrDone(cv) && !(owners[String(cv.id)] && owners[String(cv.id)].discarded_at)
        && (isLead.has(u) || (owners[String(cv.id)] && owners[String(cv.id)].owner === u))).length;
      for (const cv of list){
        const id = String(cv.id), at = cv.last_message_at; if (!at) continue;
        const prev = seen[id] && seen[id].last_at ? new Date(seen[id].last_at).getTime() : 0, t = Date.parse(at);
        if (t <= prev) continue;
        await c.query("insert into public.push_seen (conversation_id, last_at) values ($1,$2) on conflict (conversation_id) do update set last_at=excluded.last_at", [id, at]);
        if (first || !(Number(cv.unread_count || 0) > 0) || Date.now() - t > 30*60e3) continue; // solo lo nuevo que escribió el prospecto
        { // si lo último fue un mensaje del equipo (AM, Manager o Head), no se avisa
          const dir = String(cv.last_message_direction || (cv.last_message && cv.last_message.direction) || cv.last_direction || "").toLowerCase();
          if (dir && !/^in/.test(dir)) continue;
          if (inboundOk && !(inboundAt[id] > prev)) continue; }
        const o = owners[id]; if (o && o.discarded_at && new Date(o.discarded_at).getTime() > t) continue;
        // segundo intento automático: si lo que llegó fue la respuesta automática de su WhatsApp, mandamos la plantilla A/B/C
        try{ await auto.markReplied(c, id, t);
          const r = await auto.maybeAuto(c, cv, {get, post, owner:(o && o.owner) || headId, origin});
          if (r){ autos.push(r); if (!r.error) continue; } // era un bot: no avisamos
        }catch(e){ autos.push({conv:id, error:String(e.message || e)}); }
        // ya le mandamos el segundo intento y no ha contestado una persona (p. ej. su WhatsApp volvió a responder solo): no avisamos
        try{ const au = (await c.query("select replied_at from public.iskra_auto where conversation_id=$1", [id])).rows[0];
          if (au && !au.replied_at) continue; }catch(_){}
        // IA: contesta con una plantilla si está segura; si no, se marca "🙋 Revisar" (máx. 4 por vuelta para no tardar)
        let ai = null;
        if (aiN < 4 && !(o && o.discarded_at) && !(o && o.noreply_at && new Date(o.noreply_at).getTime() >= t)){
          try{ ai = await aireply.maybe(c, cv, {get, post, owner:(o && o.owner) || headId, inAt:t, origin}); if (ai){ aiN++; ais.push(ai); } }catch(e){ ais.push({conv:id, error:String(e.message || e)}); }
        }
        if (ai && ai.sent) continue; // ya lo contestó la IA con una plantilla: no avisamos
        // al dueño y siempre al Head y al Manager (ellos ven todas las conversaciones)
        const to = [...new Set([...(o && o.owner ? [o.owner] : []), ...(inboxId ? [inboxId] : []), ...leads])]; if (!to.length) continue;
        const name0 = cv.contact_name || (cv.lead && cv.lead.full_name) || cv.contact_phone || "WhatsApp";
        const name = ai && ai.flag && !ai.error ? "🙋 Revisar · " + name0 : name0;
        n++; dest += to.length;
        for (const u of to){ // cada quien con su número en el ícono: conversaciones sin leer que le tocan
          const badge = unreadFor(u);
          sent += await sendTo(c, [u], {title:name, body:String(cv.last_message_text || "Mensaje nuevo").slice(0, 160), url:"/?tab=msgs&conv=" + encodeURIComponent(id), tag:"conv-" + id, badge});
          errs.push(...(sendTo.lastErrors || []));
        }
      }
      return {ok:true, ...(importacion ? {importacion} : {}), ...(semana ? {semana} : {}), ...(reporte ? {reporte} : {}), ...(semanales ? {semanales} : {}), ...(recordatorios ? {recordatorios} : {}), ...(respuesta ? {tiempo_respuesta:respuesta} : {}), ...(emails ? {emails} : {}), ...(ais.length ? {ia:ais} : {}), ...(seguimiento ? {seguimiento} : {}), ...(recordatorio_meet ? {recordatorio_meet} : {}), ...(confirmacion_meet ? {confirmacion_meet} : {}), ...(respuesta_recordatorio ? {respuesta_recordatorio} : {}), ...(responsables ? {responsables} : {}), revisadas:list.length, nuevas:n, personas:dest, enviadas:sent, primera_vez:first, ...(autos.length ? {automaticos:autos} : {}), ...(errs.length ? {errores:errs.slice(0,3)} : {})};
    });
    res.status(out.status || 200).json(out);
  }catch(err){ res.status(500).json({error:String(err.message || err)}); }
};
