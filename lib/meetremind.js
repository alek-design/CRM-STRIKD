// Recordatorio automático por WhatsApp 30 min antes del meet (aprobado por Alek, 23 oct 2026).
// A quién: meets agendados desde un chat de ISKRA (llevan iskConvId). Se manda una vez por horario (si se reagenda, sale otra vez).
// Texto: la plantilla del panel que se llame "Recordatorio de meet" (puede usar {nombre}, {link} y {hora}); si no hay, uno por defecto.
// WhatsApp solo deja texto libre si el prospecto escribió en las últimas 24 h; si no, se usa la plantilla aprobada de ISKRA
// conectada a esa plantilla (si la tiene) o se avisa al dueño para que lo recuerde a mano.
const iskapp = require("./iskapp");
const { sendTo } = require("./push");

const OFF = 5 * 3600e3, BEFORE = 30 * 60e3;
const tsOf = s => { const m = String(s || "").match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d)/); return m ? Date.parse(m[1] + ":00-05:00") : NaN; };
const arr = j => Array.isArray(j) ? j : (j && (j.data || j.items || j.messages || j.results)) || [];
const atOf = m => Date.parse(m.created_at || m.sent_at || m.timestamp || "") || 0;
const isIn = m => /^(in|inbound|incoming|received|lead)/i.test(String(m.direction || m.dir || (m.from_me === false ? "in" : m.from_me ? "out" : "") || ""));
const fold = v => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const first = n => String(n || "").trim().split(/\s+/)[0] || "";
// la conversación de WhatsApp del prospecto: la del chat donde se agendó, o la que tenga su mismo teléfono
async function convMap(c){ const m = {}; (await c.query("select conversation_id, phone from public.iskra_owner where coalesce(phone,'') <> ''").catch(() => ({rows:[]}))).rows.forEach(r => { m[String(r.phone).slice(-10)] = String(r.conversation_id); }); return m; }
const convOf = (d, map) => d.iskConvId ? String(d.iskConvId) : (map[String(d.phone || "").replace(/\D/g, "").slice(-10)] || "");
const DEFAULT = "¡Hola {nombre}! Te recuerdo que nuestra sesión empieza en 30 minutos.{link}\n\n¡Nos vemos!"; // sin hora: así no hay confusión con la zona horaria del prospecto

async function run(c, {get, post}){
  const cfg = ((await c.query("select data from public.docs where path='config/main'")).rows[0] || {}).data || {};
  if (cfg.meetRemindAuto === false) return null;
  const now = Date.now();
  const rows = (await c.query(`select path, split_part(path,'/',2) uid, split_part(path,'/',4) id, data from public.docs
    where path like 'meets/%/items/%' and (coalesce(data->>'iskConvId','') <> '' or coalesce(data->>'phone','') <> '') and coalesce(data->>'cancelled','') <> 'true'
      and data->'flow'->>'lostAt' is null and coalesce((data->>'noMeet')::boolean, false) = false`)).rows;
  const due = rows.filter(r => { const d = r.data, at = d.reschedAt || d.meetAt, t = tsOf(at), f = d.flow || {};
    return !isNaN(t) && now >= t - BEFORE && now < t - 5 * 60e3 && f.autoRemindFor !== at && !f.inviteDeclinedAt; });
  if (!due.length) return null;
  const cmap = await convMap(c);
  const rej = new Set((await c.query("select split_part(path,'/',2) id from public.docs where path like 'validations/%' and data->>'status' in ('rejected','noshow')")).rows.map(r => r.id));
  const tplRow = (await c.query("select data from public.docs where parent='waTemplates'")).rows.map(r => r.data || {})
    .find(t => t.active !== false && !t.deleted && /recordatorio de(l)? meet/.test(fold(t.name)));
  const v = tplRow && (tplRow.variants || {}).a;
  const out = [];
  for (const r of due.slice(0, 10)){
    const d = r.data, at = d.reschedAt || d.meetAt; if (rej.has(r.id) || !convOf(d, cmap)) continue;
    // reservar antes de mandar (aunque el cron corra dos veces, sale una sola vez)
    const lock = await c.query(`update public.docs set data = jsonb_set(data, '{flow}', coalesce(data->'flow','{}'::jsonb) || jsonb_build_object('autoRemindFor', $2::text)), version = version + 1, updated_at = now()
      where path = $1 and coalesce(data->'flow'->>'autoRemindFor','') <> $2 returning 1`, [r.path, at]);
    if (!lock.rows[0]) continue;
    const hora = String(at).slice(11, 16), link = d.link ? `\n\nAquí el link: ${d.link}` : "";
    const text = String((v && v.text) || DEFAULT).replace(/\{nombre\}/gi, first(d.prospect)).replace(/\{hora\}/gi, hora).replace(/\{link\}/gi, link).replace(/\s+,/g, ",").trim();
    const conv = convOf(d, cmap);
    try{
      let lastIn = 0; try{ arr(await get(`/v1/conversations/${encodeURIComponent(conv)}/messages?limit=30`, 6000)).forEach(m => { if (isIn(m)) lastIn = Math.max(lastIn, atOf(m)); }); }catch(_){}
      if (now - lastIn < 23.5 * 3600e3) await post("/v1/messages/reply", {conversation_id:conv, idempotency_key:"remind-" + r.id + "-" + at, text});
      else if (v && v.iskTplId && iskapp.configured()) await iskapp.sendTemplate({conversation_id:conv, template_group_id:v.iskTplId, variables:{"1":text.replace(/\s*\n+\s*/g, " ")}});
      else throw new Error("pasaron más de 24 h desde su último mensaje: WhatsApp solo deja mandar una plantilla aprobada");
      await c.query(`update public.docs set data = jsonb_set(data, '{flow}', coalesce(data->'flow','{}'::jsonb) || jsonb_build_object('remindedFor', $2::text, 'remindedAt', $3::bigint, 'autoReminded', true)), version = version + 1, updated_at = now() where path = $1`, [r.path, at, now]);
      await c.query("insert into public.iskra_sent (conversation_id, user_id, text) values ($1,null,$2)", [conv, "⏰ " + text]).catch(() => {});
      out.push({meet:r.id, ok:true});
    }catch(e){
      out.push({meet:r.id, error:String(e.message || e)});
      // que el dueño lo mande a mano
      await sendTo(c, [r.uid], {title:"⏰ Recuérdale su meet a " + (d.prospect || "tu prospecto"), body:`Empieza a las ${hora}. No se pudo mandar el recordatorio automático: ${String(e.message || e).slice(0, 90)}`, url:"/?tab=agenda", tag:"remind-" + r.id}).catch(() => 0);
    }
  }
  return out.length ? out : null;
}

// Confirmación automática al agendar (Alek, 23 oct 2026): en cuanto se agenda un meet desde un chat de ISKRA, le llega un WhatsApp
// confirmando día, hora y link. Si se reagenda, le llega la nueva fecha. Solo meets creados desde CONF_SINCE (no a los viejos).
// Texto: plantilla del panel "Confirmación de meet" ({nombre}, {fecha}, {hora}, {link}); si no hay, uno por defecto.
// La hora va en la zona del prospecto según su lada: Quintana Roo (983, 984, 987, 998) hora de Cancún; el resto, hora del centro de México.
const CONF_SINCE = Date.parse("2026-10-23T20:50:00Z");
const DIAS = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"], MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
function whenFor(at, phone){
  const t = tsOf(at), d = String(phone || "").replace(/\D/g, "").slice(-10), qroo = /^(983|984|987|998)/.test(d);
  const local = new Date(t - (qroo ? 5 : 6) * 3600e3), h = local.getUTCHours(), mi = local.getUTCMinutes();
  const hora = `${((h + 11) % 12) + 1}:${String(mi).padStart(2, "0")} ${h < 12 ? "am" : "pm"}${qroo ? " (hora de Cancún)" : " (hora del centro de México)"}`;
  return {fecha:`${DIAS[local.getUTCDay()]} ${local.getUTCDate()} de ${MESES[local.getUTCMonth()]}`, hora};
}
const CONF_DEFAULT = "¡Listo {nombre}! 🙌 Quedó agendada nuestra sesión para el {fecha} a las {hora}.{link}\n\nTambién te llegará la invitación a tu correo. ¡Nos vemos!";
async function confirm(c, {post}){
  const cfg = ((await c.query("select data from public.docs where path='config/main'")).rows[0] || {}).data || {};
  if (cfg.meetConfirmAuto === false) return null;
  const now = Date.now();
  const rows = (await c.query(`select path, split_part(path,'/',2) uid, split_part(path,'/',4) id, data from public.docs
    where path like 'meets/%/items/%' and (coalesce(data->>'iskConvId','') <> '' or coalesce(data->>'phone','') <> '') and coalesce(data->>'cancelled','') <> 'true'
      and data->'flow'->>'lostAt' is null and coalesce((data->>'noMeet')::boolean, false) = false
      and (coalesce((data->>'createdAt')::bigint, 0) >= $1 or (coalesce(data->>'reschedAt','') <> '' and coalesce((data->'flow'->>'confirmedAt')::bigint, 0) >= $1))`, [CONF_SINCE])).rows;
  const due = rows.filter(r => { const d = r.data, at = d.reschedAt || d.meetAt, t = tsOf(at), f = d.flow || {};
    return !isNaN(t) && t > now + 15 * 60e3 && f.confirmSentFor !== at; });
  if (!due.length) return null;
  const tplRow = (await c.query("select data from public.docs where parent='waTemplates'")).rows.map(r => r.data || {})
    .find(t => t.active !== false && !t.deleted && /confirmacion de(l)? meet/.test(fold(t.name)));
  const v = tplRow && (tplRow.variants || {}).a, out = [], cmap = await convMap(c);
  for (const r of due.slice(0, 10)){
    const d = r.data, at = d.reschedAt || d.meetAt, again = !!(d.flow || {}).confirmSentFor || !!d.reschedAt, conv = convOf(d, cmap);
    if (!conv) continue;
    const lock = await c.query(`update public.docs set data = jsonb_set(data, '{flow}', coalesce(data->'flow','{}'::jsonb) || jsonb_build_object('confirmSentFor', $2::text, 'confirmSentAt', $3::bigint)), version = version + 1, updated_at = now()
      where path = $1 and coalesce(data->'flow'->>'confirmSentFor','') <> $2 returning 1`, [r.path, at, now]);
    if (!lock.rows[0]) continue;
    const w = whenFor(at, d.phone), link = d.link ? `\n\nAquí el link para entrar: ${d.link}` : "";
    let text = String((v && v.text) || CONF_DEFAULT).replace(/\{nombre\}/gi, first(d.prospect)).replace(/\{fecha\}/gi, w.fecha).replace(/\{hora\}/gi, w.hora).replace(/\{link\}/gi, link).replace(/\s+,/g, ",").trim();
    if (again && !v) text = text.replace("Quedó agendada nuestra sesión para el", "Cambiamos nuestra sesión al");
    try{
      await post("/v1/messages/reply", {conversation_id:conv, idempotency_key:"confirm-" + r.id + "-" + at, text});
      await c.query("insert into public.iskra_sent (conversation_id, user_id, text) values ($1,null,$2)", [conv, "✅ " + text]).catch(() => {});
      out.push({meet:r.id, ok:true});
    }catch(e){ out.push({meet:r.id, error:String(e.message || e)});
      await sendTo(c, [r.uid], {title:"✅ Confírmale su meet a " + (d.prospect || "tu prospecto"), body:`No se pudo mandar la confirmación automática por WhatsApp: ${String(e.message || e).slice(0, 90)}`, url:"/?tab=msgs&conv=" + encodeURIComponent(conv), tag:"confirm-" + r.id}).catch(() => 0); }
  }
  return out.length ? out : null;
}
module.exports = {run, confirm, whenFor};
