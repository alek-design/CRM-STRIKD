// Respuestas automáticas con IA (Claude) en WhatsApp.
// Solo elige entre las plantillas del panel (Mensajes → Plantillas) y la manda tal cual con el nombre; nunca escribe textos propios.
// Si no está segura, no manda nada: marca el chat "🙋 Revisar" con la razón y avisa al dueño.
// Modo (config/main.aiMode): "off" (apagada), "test" (solo dice qué habría contestado) u "on" (contesta sola).
// Cada decisión queda en public.iskra_ai: sirve para ver qué contestó y para juntar las preguntas frecuentes sin plantilla.
const { publicMedia, withLink } = require("./iskmedia");
const iskapp = require("./iskapp");

const MODEL = () => process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
const MIN_CONF = 0.85;          // abajo de esto, no contesta
const MAX_AUTO = 2;             // respuestas de IA seguidas sin que conteste una persona
const HUMAN_GAP = 10 * 60e3;    // si alguien del equipo contestó hace menos de esto, no se mete
const arr = j => Array.isArray(j) ? j : (j && (j.data || j.items || j.messages || j.results)) || [];
const atOf = m => Date.parse(m.created_at || m.sent_at || m.timestamp || "") || 0;
const dirOf = m => /^(in|inbound|incoming|received|lead)/i.test(String(m.direction || m.dir || (m.from_me === false ? "in" : m.from_me ? "out" : "") || "")) ? "in" : "out";
const txtOf = m => String(m.text || m.body || m.content || m.message || (m.media || m.attachment ? "[archivo]" : "") || "").trim();
const first = n => String(n || "").trim().split(/\s+/)[0] || "";
const fold = v => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9$ ]+/g, " ").replace(/\s+/g, " ").trim();
const hasPhrase = (t, ph) => [ph, ph + "s", ph + "es"].some(x => (" " + t + " ").includes(" " + x + " ")); // también en plural: costo → costos
const NEG = /\b(no me interesa|no estoy interesad|no gracias|ya no|caro|molest|queja|enojad|estafa|fraude|no me escriban|dejen de)\b/;

async function ensure(c){
  await c.query(`create table if not exists public.iskra_ai (id bigserial primary key, conversation_id text, in_at timestamptz, mode text, tpl text, variant text,
    conf real, sent boolean default false, flag boolean default false, reason text, question text, text text, error text, owner uuid, at timestamptz default now(),
    unique (conversation_id, in_at))`);
  await c.query("alter table public.iskra_ai enable row level security").catch(() => {});
}
async function mode(c){
  const cfg = ((await c.query("select data from public.docs where path='config/main'")).rows[0] || {}).data || {};
  return ["test", "on"].includes(cfg.aiMode) ? cfg.aiMode : "off"; // funciona sin IA (palabras clave); la IA es opcional
}
async function templates(c){
  const rows = (await c.query("select id, data from public.docs where parent='waTemplates'")).rows;
  return rows.filter(r => r.data && r.data.active !== false && !r.data.deleted && !["auto", "h24"].includes(r.data.trigger))
    .map(r => ({id:r.id, name:r.data.name || "", trigger:r.data.trigger || "general", kw:(Array.isArray(r.data.kw) ? r.data.kw : []).map(fold).filter(x => x.length >= 3),
      variants:Object.entries(r.data.variants || {}).filter(([, v]) => v && String(v.text || "").trim())}))
    .filter(t => t.variants.length);
}
async function ask(system, user){
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 20000);
  try{
    const r = await fetch("https://api.anthropic.com/v1/messages", {method:"POST", signal:ctl.signal,
      headers:{"x-api-key":process.env.ANTHROPIC_API_KEY, "anthropic-version":"2023-06-01", "content-type":"application/json"},
      body:JSON.stringify({model:MODEL(), max_tokens:400, system, messages:[{role:"user", content:user}]})});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("Claude " + r.status + ": " + ((j.error && j.error.message) || ""));
    const t = (j.content || []).map(x => x.text || "").join("");
    const m = t.match(/\{[\s\S]*\}/); if (!m) throw new Error("respuesta sin JSON");
    return JSON.parse(m[0]);
  } finally { clearTimeout(tm); }
}

// cv: conversación con mensaje nuevo del prospecto (inAt). Devuelve {sent, flag, ...} o null si no aplica.
async function maybe(c, cv, {get, post, owner, inAt, origin}){
  const md = await mode(c); if (md === "off") return null;
  await ensure(c);
  const id = String(cv.id), inTs = new Date(inAt || Date.now());
  // una sola decisión por mensaje del prospecto
  const ins = await c.query("insert into public.iskra_ai (conversation_id, in_at, mode, owner) values ($1,$2,$3,$4) on conflict do nothing returning id", [id, inTs, md, owner || null]);
  if (!ins.rows[0]) return null;
  const rid = ins.rows[0].id, save = (patch) => {
    const k = Object.keys(patch); return c.query(`update public.iskra_ai set ${k.map((x, i) => `${x}=$${i + 2}`).join(", ")} where id=$1`, [rid, ...k.map(x => patch[x])]);
  };
  try{
    const msgs = arr(await get(`/v1/conversations/${encodeURIComponent(id)}/messages?limit=20`, 6000)).filter(atOf).sort((a, b) => atOf(a) - atOf(b));
    if (!msgs.length || dirOf(msgs[msgs.length - 1]) !== "in") { await save({reason:"lo último no es del prospecto"}); return null; }
    // ¿contestó alguien del equipo hace poco (desde el panel o desde la app de ISKRA)? ¿cuántas respuestas de IA seguidas lleva?
    const aiTexts = new Set((await c.query("select text from public.iskra_ai where conversation_id=$1 and sent and text is not null order by at desc limit 20", [id])).rows.map(x => x.text.replace(/\s+/g, " ").trim()));
    const isAi = m => aiTexts.has(txtOf(m).replace(/\s+/g, " ").trim());
    const outs = msgs.filter(m => dirOf(m) === "out"), lastHumanOut = outs.filter(m => !isAi(m)).pop();
    if (lastHumanOut && Date.now() - atOf(lastHumanOut) < HUMAN_GAP){ await save({reason:"alguien del equipo contestó hace poco"}); return null; }
    const nAi = outs.filter(m => isAi(m) && (!lastHumanOut || atOf(m) > atOf(lastHumanOut))).length;
    const tpls = await templates(c);
    const name = cv.contact_name || (cv.lead && cv.lead.full_name) || "";
    // 1) palabras clave (sin IA): lo que escribió seguido el prospecto vs. las 🔑 de cada plantilla
    const tail = []; for (let i = msgs.length - 1; i >= 0 && dirOf(msgs[i]) === "in"; i--) tail.unshift(txtOf(msgs[i]));
    const said = fold(tail.join(" ")), qn = said.slice(0, 60);
    const hits = tpls.map(t => [t, t.kw.filter(k => hasPhrase(said, k))]).filter(([, h]) => h.length);
    let pick = null, conf = 0, reason = "", question = /\?/.test(tail.join(" ")) ? qn : "";
    if (hits.length){
      if (NEG.test(said)){ await save({flag:true, reason:"coincide con palabras clave pero parece objeción o queja", question:qn}); return {conv:id, flag:true, reason:"posible objeción"}; }
      if (said.length > 260){ await save({flag:true, reason:"mensaje largo: mejor que lo lea una persona", question:qn}); return {conv:id, flag:true, reason:"mensaje largo"}; }
      if (hits.length > 1){ await save({flag:true, reason:"coincide con varias plantillas: " + hits.map(([t]) => t.name).join(", "), question:qn}); return {conv:id, flag:true, reason:"varias plantillas"}; }
      pick = hits[0][0]; conf = 1; reason = "escribió “" + hits[0][1][0] + "”";
    } else if (!process.env.ANTHROPIC_API_KEY){
      await save({reason:"sin coincidencias", question}); return null; // sin IA: se queda como pendiente normal
    }
    if (!pick){
    const convo = msgs.slice(-12).map(m => `${dirOf(m) === "in" ? "PROSPECTO" : "STRIKD"}: ${txtOf(m).slice(0, 600)}`).join("\n");
    const system = `Eres el asistente del equipo de ventas de STRIKD (app de entrenamiento con la que nutriólogos y entrenadores venden programas con su marca).
Lees un chat de WhatsApp con un prospecto y decides si una de las PLANTILLAS del equipo contesta exactamente lo último que escribió.
Reglas:
- Solo puedes elegir una plantilla de la lista (por su id) o ninguna. Nunca escribes texto propio.
- Elige una plantilla solo si responde de forma correcta y completa lo que el prospecto pregunta o dice ahora, sin contradecir lo ya hablado.
- Si pide algo personal, una fecha/horario concreto, negocia, se queja, está molesto, pide hablar con alguien, o hay cualquier duda: ninguna.
- Si el mensaje no necesita respuesta (gracias, ok, emoji) también: ninguna.
- "confianza" de 0 a 1: qué tan seguro estás de que esa plantilla es la respuesta correcta.
Responde SOLO un JSON: {"plantilla": "<id o null>", "confianza": 0.0, "razon": "<una frase en español>", "pregunta": "<qué pide el prospecto, en 3 a 8 palabras, genérico (sin nombres)>"}`;
    const user = `PLANTILLAS:\n${tpls.map(t => `- id: ${t.id} | ${t.name} | tipo: ${t.trigger}\n  texto: ${String(t.variants[0][1].text).slice(0, 500).replace(/\n/g, " ")}`).join("\n") || "(no hay plantillas)"}\n\nCHAT (del más viejo al más nuevo):\n${convo}`;
    const r = await ask(system, user);
    pick = tpls.find(x => x.id === String(r.plantilla || "")) || null; conf = Math.max(0, Math.min(1, Number(r.confianza) || 0));
    reason = String(r.razon || "").slice(0, 300); question = String(r.pregunta || "").slice(0, 120);
    }
    const t = pick;
    if (!t || conf < MIN_CONF){ await save({flag:true, conf, reason:reason || "no hay plantilla que conteste esto", question, tpl:t ? t.id : null}); return {conv:id, flag:true, reason, question}; }
    if (nAi >= MAX_AUTO){ await save({flag:true, conf, tpl:t.id, reason:"ya se contestaron " + nAi + " seguidas con IA: le toca a una persona", question}); return {conv:id, flag:true, reason:"le toca a una persona", question}; }
    // variante con menos envíos
    const counts = {}; (await c.query("select variant, count(*)::int n from public.iskra_ai where tpl=$1 and sent group by variant", [t.id])).rows.forEach(x => counts[x.variant] = x.n);
    const [vk, v] = t.variants.slice().sort((a, b) => (counts[a[0]] || 0) - (counts[b[0]] || 0))[0];
    const text = String(v.text).replace(/\{nombre\}/gi, first(name)).replace(/\s+,/g, ",").trim();
    if (md === "test"){ await save({tpl:t.id, variant:vk, conf, reason, question, text}); return {conv:id, test:true, tpl:t.name}; }
    const base = {conversation_id:id, idempotency_key:"ai-" + id + "-" + inTs.getTime()};
    let done = false;
    if (v.fileId && iskapp.configured()){
      try{ const pm = await publicMedia({url:"/_blob/" + v.fileId, name:v.fileName || "STRIKD.pdf"}); const cap = text.length <= 1024 ? text : "";
        await iskapp.sendMedia({conversation_id:id, text:cap, media:{...pm, name:v.fileName || "STRIKD.pdf"}}); if (!cap) await post("/v1/messages/reply", {...base, text}); done = true; }
      catch(_){ try{ const pm = await publicMedia({url:"/_blob/" + v.fileId, name:v.fileName || "STRIKD.pdf"}); await post("/v1/messages/reply", {...base, text:withLink(text, pm, origin)}); done = true; }catch(__){} }
    }
    if (!done) await post("/v1/messages/reply", {...base, text});
    await c.query("insert into public.iskra_sent (conversation_id, user_id, text) values ($1,null,$2)", [id, "🤖 " + text]).catch(() => {});
    await save({sent:true, tpl:t.id, variant:vk, conf, reason, question, text});
    return {conv:id, sent:true, tpl:t.name};
  }catch(e){
    await save({flag:true, error:String(e.message || e).slice(0, 300), reason:"la IA no pudo revisarlo"}).catch(() => {});
    return {conv:id, flag:true, error:String(e.message || e)};
  }
}

// lo último que decidió la IA por conversación (para la lista y el chat)
async function latest(c, ids){
  if (!ids.length) return {};
  try{ await ensure(c); }catch(_){ return {}; }
  const rows = (await c.query(`select distinct on (conversation_id) conversation_id, in_at, mode, tpl, conf, sent, flag, reason, question, text, at
    from public.iskra_ai where conversation_id = any($1) and (sent or flag or text is not null) order by conversation_id, in_at desc`, [ids]).catch(() => ({rows:[]}))).rows;
  const out = {}; rows.forEach(r => out[r.conversation_id] = {inAt:new Date(r.in_at).getTime(), mode:r.mode, tpl:r.tpl, conf:r.conf, sent:r.sent, flag:r.flag, reason:r.reason, question:r.question, text:r.text});
  return out;
}
// resumen para Plantillas: estado, envíos y preguntas frecuentes sin plantilla (últimos 30 días)
async function summary(c){
  const md = await mode(c).catch(() => "off");
  try{ await ensure(c); }catch(_){}
  const st = (await c.query(`select count(*) filter (where sent)::int sent, count(*) filter (where flag)::int flag, count(*) filter (where mode='test' and text is not null)::int would
    from public.iskra_ai where at > now() - interval '30 days'`).catch(() => ({rows:[{}]}))).rows[0] || {};
  const faq = (await c.query(`select lower(question) q, count(*)::int n, max(at) last from public.iskra_ai where (flag or reason = 'sin coincidencias') and not sent and question is not null and question <> '' and at > now() - interval '30 days'
    group by lower(question) order by n desc, last desc limit 15`).catch(() => ({rows:[]}))).rows;
  const byTpl = (await c.query(`select tpl, count(*)::int n from public.iskra_ai where (sent or (mode='test' and text is not null)) and at > now() - interval '30 days' group by tpl`).catch(() => ({rows:[]}))).rows;
  return {mode:md, key:!!process.env.ANTHROPIC_API_KEY, model:MODEL(), sent:st.sent || 0, flag:st.flag || 0, would:st.would || 0, faq, byTpl};
}
module.exports = {maybe, latest, summary, ensure};
