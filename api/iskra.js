// Puente con ISKRA (WhatsApp). La llave vive solo en Vercel (ISKRA_API_KEY); el navegador nunca la ve.
// Un solo número de STRIKD, varias personas: cada conversación tiene dueño.
//  · Head y Creator Partnerships Manager ven todas; el Account Manager solo las suyas (lo filtra el servidor).
//  · Conversación nueva → se asigna sola: opción "load" (menos carga) u opción "best" (mejores resultados, 4 semanas).
//  · Cada envío queda registrado con quién lo mandó. Envíos siempre por clic de una persona, con idempotency_key.
const { withPg, userFromReq } = require("../lib/google");
const resptime = require("../lib/resptime");
const { publicMedia, mediaPayload, asAttachment, withLink, shapes } = require("../lib/iskmedia");
const iskapp = require("../lib/iskapp");
const aireply = require("../lib/aireply");
const stall = require("../lib/stallfollow");
const BASE = (process.env.ISKRA_API_URL || "https://xglfamaaotmwulglwcui.supabase.co/functions/v1/public-api").replace(/\/$/, "");
const enc = encodeURIComponent;
const digits = x => String(x || "").replace(/\D/g, "").slice(-10);
const arr = j => Array.isArray(j) ? j : (j && (j.data || j.items || j.conversations || j.messages || j.results)) || [];
const convId = c => String(c.id || c.conversation_id || "");
const convPhone = c => { const ct = c.contact || c.lead || {}; return c.phone || c.lead_phone || c.contact_phone || ct.phone || c.wa_id || ""; };

async function iskra(method, path, payload, timeoutMs){
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), timeoutMs || 15000);
  try{
    const r = await fetch(BASE + path, {method, signal:ctl.signal, headers:{authorization:"Bearer " + process.env.ISKRA_API_KEY, "content-type":"application/json"}, body: payload ? JSON.stringify(payload) : undefined});
    const text = await r.text(); let j; try{ j = JSON.parse(text); }catch(_){ j = {raw:text.slice(0, 2000)}; }
    if (!r.ok){ const er = j && j.error, em = (er && typeof er==="object" ? (er.message || er.code) : er) || (j && j.message) || ("ISKRA " + r.status);
      throw Object.assign(new Error(String(em)), {status:r.status, detail:j}); }
    return j;
  }catch(e){ if (e.name === "AbortError") throw Object.assign(new Error("ISKRA tardó demasiado"), {status:504}); throw e; }
  finally{ clearTimeout(to); }
}
// Lista de conversaciones: primera página cada 10 s; hasta 4 páginas cada 60 s (por si la actividad nueva no viene arriba).
// Además, los mensajes entrantes de las últimas 2 h (con fecha, para que ISKRA no tarde) para no perder ninguno nuevo.
let LIST_CACHE = {at:0, deepAt:0, data:null, p:null, info:{}};
const MSG_CACHE = {}, OWN_CACHE = {}, TPL_CACHE = {at:0, data:null}, REP_CACHE = {at:0, data:null};
const lastAtOf = cv => Date.parse(cv.last_message_at || (cv.last_message && cv.last_message.created_at) || cv.updated_at || cv.created_at || "") || 0;
async function iskList(){
  if (LIST_CACHE.data && Date.now() - LIST_CACHE.at < 10e3) return LIST_CACHE.data;
  if (LIST_CACHE.p) return LIST_CACHE.p;
  LIST_CACHE.p = (async () => {
    const info = {paginas:0};
    const deep = !LIST_CACHE.data || Date.now() - LIST_CACHE.deepAt > 60e3;
    const all = {}; (LIST_CACHE.data || []).forEach(cv => { all[String(cv.id)] = cv; });
    let cursor = "", pages = deep ? 4 : 1;
    while (pages-- > 0){
      const j = await iskra("GET", "/v1/conversations?limit=100" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), null, 10000);
      info.paginas++; arr(j).forEach(cv => { all[String(cv.id || cv.conversation_id)] = cv; });
      cursor = j && j.next_cursor; if (!cursor || !(j.has_more ?? true)) break;
    }
    // entrantes recientes: si ISKRA los da rápido, metemos esas conversaciones aunque no vengan en la lista
    const since = new Date(Date.now() - 2*3600e3).toISOString();
    try{
      const q = `/v1/messages/whatsapp?direction=inbound&limit=50&from=${encodeURIComponent(since)}&since=${encodeURIComponent(since)}&date_from=${encodeURIComponent(since)}`;
      const ms = arr(await iskra("GET", q, null, 4000));
      info.entrantes_recientes = ms.length;
      ms.forEach(m => {
        const id = String(m.conversation_id || (m.conversation && m.conversation.id) || ""); if (!id) return;
        const at = m.created_at || m.sent_at || m.timestamp;
        const cv = all[id] || (all[id] = {id, contact_phone:m.phone || m.from || m.contact_phone || "", contact_name:m.contact_name || null});
        if (!cv.last_message_at || Date.parse(at) > Date.parse(cv.last_message_at)){ cv.last_message_at = at; cv.last_message_text = m.text || m.body || m.content || cv.last_message_text; }
        cv.unread_count = Math.max(1, Number(cv.unread_count || 0));
      });
    }catch(e){ info.entrantes_recientes_error = e.message; }
    const data = Object.values(all).sort((a, b) => lastAtOf(b) - lastAtOf(a)).slice(0, 400);
    info.mas_reciente = data[0] ? (data[0].last_message_at || null) : null;
    LIST_CACHE = {at:Date.now(), deepAt:deep ? Date.now() : LIST_CACHE.deepAt, data, p:null, info};
    return data;
  })().catch(e => { LIST_CACHE.p = null; throw e; });
  return LIST_CACHE.p;
}
const SQL_INIT = `
create table if not exists public.iskra_owner (conversation_id text primary key, phone text, owner uuid, assigned_at timestamptz default now(),
  assigned_by text, escalated_at timestamptz, last_sender uuid, last_sent_at timestamptz);
alter table public.iskra_owner add column if not exists replied_at timestamptz;
alter table public.iskra_owner add column if not exists discarded_at timestamptz;
alter table public.iskra_owner add column if not exists discarded_by uuid;
alter table public.iskra_owner add column if not exists noreply_at timestamptz;
alter table public.iskra_owner add column if not exists interest_at timestamptz;
alter table public.iskra_owner add column if not exists interest_by uuid;
alter table public.iskra_owner add column if not exists noreply_by uuid;
create table if not exists public.iskra_seen (conversation_id text primary key, last_at timestamptz, last_dir text, replied boolean default false, checked_at timestamptz);
alter table public.iskra_seen add column if not exists real boolean;
alter table public.iskra_seen add column if not exists email_ask_at timestamptz;
alter table public.iskra_seen enable row level security;
create table if not exists public.iskra_sent (id bigserial primary key, conversation_id text, user_id uuid, text text, at timestamptz default now());
alter table public.iskra_owner enable row level security; alter table public.iskra_sent enable row level security;`;

// Elige dueño para conversaciones nuevas. Carga todo una sola vez por petición (rápido aunque lleguen muchas juntas).
// Bandeja única (Alek, 23 oct 2026): todas las conversaciones de WhatsApp le llegan a Rafa (partners@strikd.ai).
// config/main.iskInbox: true/sin definir = encendido; false = reparto normal (menos carga / mejores resultados). iskInboxEmail cambia el correo.
async function inboxOf(c, cfg){
  if (cfg && cfg.iskInbox === false) return null;
  const mail = (cfg && cfg.iskInboxEmail) || ((cfg && cfg.perfilInvite) || {1:"partners@strikd.ai"})[1] || "partners@strikd.ai";
  const u = (await c.query("select id from public.app_users where lower(email)=lower($1) and coalesce(active,true)", [String(mail)])).rows[0];
  globalThis.__iskInbox = u ? String(u.id) : null;
  return globalThis.__iskInbox;
}
function makePicker(c, mode, inbox){
  if (inbox) return async () => ({owner:inbox, by:"bandeja"});
  let ready = null;
  const load0 = async () => {
    const phones = {};
    (await c.query(`select split_part(path,'/',2) as uid, right(regexp_replace(coalesce(data->>'phone',''),'\\D','','g'),10) as d from public.docs
      where (path like 'meets/%/items/%' or path like 'meets/%/waleads/%') and coalesce(data->>'phone','') <> ''`)).rows.forEach(r => { if (r.d && !phones[r.d]) phones[r.d] = r.uid; });
    const users = (await c.query("select id, role from public.app_users where active")).rows;
    const active = new Set(users.map(u => u.id));
    // la Influencer Outreach también es "am" en accesos, pero no lleva conversaciones de WhatsApp
    const infl = new Set((await c.query("select split_part(path,'/',2) id from public.docs where parent='roles' and data->>'role'='influencer'")).rows.map(r => r.id));
    const ams = users.filter(u => u.role === "am" && !infl.has(u.id)).map(u => u.id);
    const fallback = (users.find(u => u.role === "manager") || users.find(u => u.role === "head") || {}).id || null;
    const load = Object.fromEntries(ams.map(id => [id, 0]));
    if (ams.length) (await c.query("select owner, count(*)::int n from public.iskra_owner where owner = any($1) and replied_at is not null group by owner", [ams])).rows.forEach(x => load[x.owner] = x.n);
    const score = {};
    if (mode === "best" && ams.length) (await c.query(`select split_part(path,'/',2) uid, sum(coalesce((data->>'pts')::numeric,0)) pts from public.docs
      where path like 'points/%/ev/%' and coalesce((data->>'at')::bigint,0) >= $1 group by 1`, [Date.now() - 28*864e5])).rows.forEach(x => score[x.uid] = Number(x.pts));
    return {phones, active, ams, fallback, load, score};
  };
  return async phone => {
    const k = await (ready ||= load0());
    const d = digits(phone), u = d && k.phones[d];
    if (u && k.active.has(u)) return {owner:u, by:"prospecto"};
    if (!k.ams.length) return {owner:k.fallback, by:"sin-am"};
    const am = k.ams.slice().sort((a, b) => mode === "best" ? ((k.score[b]||0) - (k.score[a]||0)) || (k.load[a] - k.load[b]) : (k.load[a] - k.load[b]) || ((k.score[b]||0) - (k.score[a]||0)))[0];
    k.load[am]++;
    return {owner:am, by:mode === "best" ? "mejores-resultados" : "menos-carga"};
  };
}

module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") return res.status(405).json({error:"POST"});
  const me = await userFromReq(req);
  if (!me) return res.status(401).json({error:"Sesión no válida"});
  if (!["head", "manager", "am"].includes(me.role)) return res.status(403).json({error:"Sin acceso a WhatsApp."});
  if (!process.env.ISKRA_API_KEY) return res.json({configured:false});
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const op = body.op, input = body.input || {};
  // Vista de usuario: el Head puede ver WhatsApp exactamente como lo ve otra persona (solo filtra; lo que mande queda a su nombre)
  const asId = me.role === "head" && /^[0-9a-f-]{36}$/i.test(String(input.as || "")) ? String(input.as) : null;
  const lead = me.role !== "am" && !asId, viewId = asId || me.id;
  // Ruta rápida para el chat abierto: solo lo nuevo desde cierta hora (sin base de datos si ya sabemos que es suyo).
  if (op === "tail"){
    try{
      const id = String(input.id || ""); if (!id) return res.status(400).json({error:"Falta id"});
      if (!lead && OWN_CACHE[id] !== viewId && !(globalThis.__iskInbox && viewId === globalThis.__iskInbox)){
        const ok = await withPg(async c => (await c.query("select owner from public.iskra_owner where conversation_id=$1", [id])).rows[0]);
        if (!ok || ok.owner !== viewId) return res.status(403).json({error:"Esta conversación es de otra persona."});
        OWN_CACHE[id] = ok.owner;
      }
      const since = new Date(Math.max(0, Number(input.since) || Date.now() - 600e3) - 2000).toISOString();
      const q = `/v1/messages/whatsapp?conversation_id=${enc(id)}&conversation=${enc(id)}&from=${enc(since)}&since=${enc(since)}&date_from=${enc(since)}&limit=50`;
      const ms = arr(await iskra("GET", q, null, 5000)).filter(m => String(m.conversation_id || (m.conversation && m.conversation.id) || "") === id); // estricto: nunca mezclar chats
      return res.json({configured:true, data:{data:ms}});
    }catch(err){ return res.status(err.status || 502).json({configured:true, error:String(err.message || err)}); }
  }
  try{
    const out = await withPg(async c => {
      if (!globalThis.__iskInit){ await c.query(SQL_INIT); globalThis.__iskInit = true; } // solo una vez por arranque
      const ownerOf = async id => (await c.query("select * from public.iskra_owner where conversation_id=$1", [String(id)])).rows[0];
      const mustOwn = async id => { const o = await ownerOf(id); if (!lead && globalThis.__iskInbox === undefined) await inboxOf(c, ((await c.query("select data from public.docs where path='config/main'")).rows[0] || {}).data).catch(() => {}); if (!lead && (!o || o.owner !== viewId) && !(globalThis.__iskInbox && viewId === globalThis.__iskInbox)) throw Object.assign(new Error("Esta conversación es de otra persona."), {status:403}); return o; };
      if (op === "findcopies"){ // solo Head: buscar dónde guarda ISKRA las copies (para mandarlas después de 24 h)
        if (me.role !== "head") throw Object.assign(new Error("Solo el Head."), {status:403});
        if (!iskapp.configured()) throw Object.assign(new Error("Falta la cuenta de ISKRA en Vercel"), {status:400});
        return {data:await iskapp.findCopies(input.q)};
      }
      if (op === "audioget"){ // notas de voz para reproducir en iPhone (el navegador no siempre puede bajarlas directo)
        const u = String(input.url || "");
        if (!/^https:\/\/(filemanager\.gupshup\.io|[a-z0-9]+\.supabase\.co)\//i.test(u)) throw Object.assign(new Error("Link no permitido"), {status:400});
        const r = await fetch(u); if (!r.ok) throw Object.assign(new Error("No se pudo bajar el audio (" + r.status + ")"), {status:502});
        const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 8 * 1024 * 1024) throw Object.assign(new Error("Audio muy pesado"), {status:413});
        return {b64:buf.toString("base64"), type:r.headers.get("content-type") || ""};
      }
      if (op === "convmedia"){ // archivos de una conversación vía la app de ISKRA (fotos que manda el cliente, PDFs, audios)
        if (!iskapp.configured() || !input.conversation_id) return {data:[]};
        await mustOwn(input.conversation_id);
        return {data:await iskapp.convMedia(String(input.conversation_id))};
      }
      if (op === "whoami"){ const j = await iskra("GET", "/v1/whoami"); return {data:j, me:{id:me.id, role:me.role}, media:iskapp.configured(), mediaMissing:iskapp.missing()}; }
      if (op === "conversations"){
        // Solo conversaciones donde el prospecto YA contestó al menos una vez.
        // ISKRA no dice en la lista quién escribió el último mensaje, así que:
        //  · unread_count > 0 → el prospecto escribió;
        //  · si cambió la conversación (last_message_at), leemos sus mensajes (máx. 8 por vuelta) y guardamos lo que vimos.
        const T = {}, t0 = Date.now();
        const list = await iskList(); T.iskra = Date.now() - t0;
        const ids = list.map(convId).filter(Boolean), byId = {};
        list.forEach(cv => { const id = convId(cv); if (id) byId[id] = cv; });
        const known = {}, seen = {}, autoS = {};
        if (ids.length){
          await c.query("alter table public.iskra_seen add column if not exists real boolean").catch(() => {});
          (await c.query("select conversation_id, sent_at, replied_at from public.iskra_auto where conversation_id = any($1)", [ids]).catch(() => ({rows:[]}))).rows.forEach(o => autoS[o.conversation_id] = o);
          (await c.query("select * from public.iskra_owner where conversation_id = any($1)", [ids])).rows.forEach(o => known[o.conversation_id] = o);
          (await c.query("select * from public.iskra_seen where conversation_id = any($1)", [ids])).rows.forEach(o => seen[o.conversation_id] = o);
        }
        const lastAt = cv => cv.last_message_at || (cv.last_message && cv.last_message.created_at) || cv.updated_at || "";
        const stale = id => { const sn = seen[id]; return !sn || !sn.last_at || Date.parse(lastAt(byId[id])) > new Date(sn.last_at).getTime() + 1000; };
        // "real": contestó una persona. No cuenta la respuesta automática de su WhatsApp Business (llega en ≤ 90 s
        // después de nuestro primer mensaje o de nuestro segundo intento automático).
        const needReal = id => seen[id] && seen[id].replied && seen[id].real == null;
        // se revisa todo lo que tuvo movimiento: aunque ISKRA marque "sin leer", lo último pudo mandarlo alguien del equipo desde la app de ISKRA
        const toCheck = ids.filter(id => stale(id) || needReal(id))
          .sort((a, b) => (stale(b) ? 1 : 0) - (stale(a) ? 1 : 0)).slice(0, 12);
        await Promise.all(toCheck.map(async id => {
          try{
            const ms = arr(await iskra("GET", `/v1/conversations/${enc(id)}/messages?limit=30`));
            const isIn = m => /^(in|inbound|incoming|received|lead)/i.test(String(m.direction || m.dir || (m.from_me===false ? "in" : m.from_me ? "out" : "") || ""));
            const at = m => Date.parse(m.created_at || m.sent_at || m.timestamp || "") || 0;
            const sorted = ms.slice().sort((x, y) => at(y) - at(x));
            const replied = ms.some(isIn), lastDir = sorted[0] ? (isIn(sorted[0]) ? "in" : "out") : null;
            const asc = sorted.slice().reverse(), first = asc[0];
            const o1 = first && !isIn(first) ? at(first) : 0, a1 = autoS[id] ? new Date(autoS[id].sent_at).getTime() : 0, W = 90e3;
            const isAutoIn = m => { const t = at(m); return (o1 && t >= o1 && t - o1 <= W) || (a1 && t >= a1 - 5e3 && t - a1 <= W); };
            const real = ms.some(m => isIn(m) && !isAutoIn(m)) || !!(autoS[id] && autoS[id].replied_at);
            // ¿le pedimos su correo y todavía no lo manda? (se fija arriba en Mensajes hasta que llegue un mensaje suyo con un email)
            const tx = m => String(m.text || m.body || m.content || m.message || "");
            let ask = null; for (const m of asc){ if (!isIn(m) && /((me|nos) (das|compartes|pasas|mandas|regalas|puedes (dar|compartir|pasar|mandar|regalar))|cual es|compart[ei]me|pasame|mandame|regalame|necesito|ocupo).{0,40}(correo|e-?mail|\bmail\b)|(correo|e-?mail).{0,30}\?|(tu|su) (correo|e-?mail)( electronico)?,? (por favor|porfa|para)/i.test(tx(m).normalize("NFD").replace(/[\u0300-\u036f]/g, ""))) ask = at(m); else if (ask && isIn(m) && /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(tx(m))) ask = null; }
            const askAt = ask ? new Date(ask).toISOString() : null;
            seen[id] = {conversation_id:id, last_at:lastAt(byId[id]) || null, last_dir:lastDir, replied, real, email_ask_at:askAt};
            await c.query(`insert into public.iskra_seen (conversation_id, last_at, last_dir, replied, real, checked_at, email_ask_at) values ($1,$2,$3,$4,$5,now(),$6)
              on conflict (conversation_id) do update set last_at=excluded.last_at, last_dir=excluded.last_dir, replied=public.iskra_seen.replied or excluded.replied, real=coalesce(public.iskra_seen.real,false) or excluded.real, checked_at=now(), email_ask_at=excluded.email_ask_at`,
              [id, lastAt(byId[id]) || null, lastDir, replied, real, askAt]);
          }catch(_){ /* se reintenta en la siguiente vuelta */ }
        }));
        T.mensajes = Date.now() - t0;
        // Solo conversaciones reales: si ya sabemos que la única "respuesta" fue automática, no sale en Mensajes
        const replied = id => {
          const sn = seen[id], au = autoS[id];
          if (au && au.replied_at) return true;
          if (sn && sn.real === true) return true;
          if (sn && sn.real === false) return false;
          if (au) return false; // tuvo respuesta automática y nadie ha contestado de verdad
          return !!((known[id] && known[id].replied_at) || (sn && sn.replied) || Number(byId[id].unread_count || 0) > 0);
        };
        const cfg = (await c.query("select data from public.docs where path='config/main'")).rows[0];
        const inbox = await inboxOf(c, cfg && cfg.data).catch(() => null);
        const mode = inbox ? "one" : cfg && cfg.data && cfg.data.iskAssign === "best" ? "best" : "load";
        // los chats que tenían otros AM pasan a Rafa (los del Head y del Manager se quedan con ellos); una vez cada 5 min por instancia
        if (inbox && (!globalThis.__iskMove || Date.now() - globalThis.__iskMove > 300e3)){
          globalThis.__iskMove = Date.now();
          const mv = await c.query(`update public.iskra_owner set owner=$1, assigned_by='bandeja' where owner is not null and owner <> $1
            and owner not in (select id::text from public.app_users where role in ('head','manager')) returning conversation_id`, [inbox]).catch(() => ({rows:[]}));
          mv.rows.forEach(r => OWN_CACHE[r.conversation_id] = inbox);
        }
        const out = [], pick = makePicker(c, mode, inbox), sees = lead || (inbox && viewId === inbox);
        for (const id of ids){
          if (!replied(id)) continue;
          const cv = byId[id], sn = seen[id];
          // dirección del último mensaje: lo que vimos, o "entrante" si hay sin leer, o "saliente" si alguien del equipo contestó después
          let dir = sn && !stale(id) ? sn.last_dir : null;
          if (!dir && Number(cv.unread_count || 0) > 0) dir = "in"; // solo si no sabemos: el "sin leer" de ISKRA no se limpia cuando contesta alguien del equipo desde su app
          const o0 = known[id];
          if (!dir && o0 && o0.last_sent_at && new Date(o0.last_sent_at).getTime() >= Date.parse(lastAt(cv)) - 5000) dir = "out";
          const norm = {...cv, id, phone:cv.contact_phone || convPhone(cv), lead_name:cv.contact_name || (cv.lead && (cv.lead.full_name || [cv.lead.first_name, cv.lead.last_name].filter(Boolean).join(" "))) || "",
            last_message:{text:cv.last_message_text || (cv.last_message && cv.last_message.text) || "", direction:dir === "in" ? "inbound" : dir === "out" ? "outbound" : "", created_at:lastAt(cv)},
            email:cv.lead && cv.lead.email || "", instagram:cv.lead && cv.lead.instagram || ""};
          let o = o0;
          if (!o){
            const p = await pick(norm.phone);
            o = (await c.query(`insert into public.iskra_owner (conversation_id, phone, owner, assigned_by, replied_at) values ($1,$2,$3,$4,now())
              on conflict (conversation_id) do update set replied_at=coalesce(public.iskra_owner.replied_at, now()) returning *`, [id, digits(norm.phone), p.owner, p.by])).rows[0];
          } else if (!o.replied_at){
            await c.query("update public.iskra_owner set replied_at=now() where conversation_id=$1", [id]); o.replied_at = new Date();
            if (!o.owner){ const p = await pick(norm.phone); await c.query("update public.iskra_owner set owner=$2, assigned_by=$3 where conversation_id=$1", [id, p.owner, p.by]); o.owner = p.owner; o.assigned_by = p.by; }
          } else if (!o.owner && !o.discarded_at && o.assigned_by !== "manual"){
            // contestó pero se quedó sin dueño (p. ej. cuando llegó no había a quién asignarlo): se asigna ahora
            const p = await pick(norm.phone);
            if (p.owner){ await c.query("update public.iskra_owner set owner=$2, assigned_by=$3 where conversation_id=$1 and owner is null", [id, p.owner, p.by]); o.owner = p.owner; o.assigned_by = p.by; }
          }
          OWN_CACHE[id] = o.owner;
          if (sees || o.owner === viewId) out.push({...norm, _strikd:{owner:o.owner, assignedBy:o.assigned_by, escalatedAt:o.escalated_at, lastSender:o.last_sender, lastSentAt:o.last_sent_at, discardedAt:o.discarded_at, discardedBy:o.discarded_by, noReplyAt:o.noreply_at, interestAt:o.interest_at, emailAskAt:(seen[id] && seen[id].email_ask_at) || null}});
        }
        // esperando respuesta desde (tiempo de respuesta)
        try{ const wm = await resptime.waitMap(c, out.map(x => String(x.id))); out.forEach(x => { if (wm[String(x.id)]) x._strikd.waitSince = wm[String(x.id)]; }); }catch(_){}
        // lo último que decidió la IA (contestó, "habría contestado" en prueba, o 🙋 revisar)
        try{ const am = await aireply.latest(c, out.map(x => String(x.id))); out.forEach(x => { if (am[String(x.id)]) x._strikd.ai = am[String(x.id)]; }); }catch(_){}
        T.total = Date.now() - t0; res.setHeader("server-timing", `iskra;dur=${T.iskra}, total;dur=${T.total}`);
        const debug = lead ? {tiempos_ms:T, lista:LIST_CACHE.info, conversaciones_en_lista:list.length, revisadas_esta_vuelta:toCheck.length, pendientes_de_revisar:ids.filter(stale).length - toCheck.length, con_respuesta:out.length, ejemplo_conversacion:list[0] || null} : undefined;
        return {data:{data:out}, mode, inbox, debug};
      }
      if (op === "messages"){
        if (!input.id) throw Object.assign(new Error("Falta id"), {status:400});
        await mustOwn(input.id);
        // ISKRA puede regresar los mensajes del más viejo al más nuevo: recorremos páginas hasta el final para tener lo último.
        // Caché: si la conversación no ha cambiado (según la lista), no volvemos a pedirla.
        const cvL = (LIST_CACHE.data || []).find(x => String(x.id) === String(input.id)), lastL = cvL ? lastAtOf(cvL) : 0;
        const mc = MSG_CACHE[input.id];
        if (!input.force && mc && lastL && mc.lastL === lastL && Date.now() - mc.at < 120e3){
          const sent0 = (await c.query("select user_id, text, extract(epoch from at)*1000 as at from public.iskra_sent where conversation_id=$1 order by at desc limit 200", [String(input.id)])).rows;
          return {data:mc.data, sent:sent0.map(x => ({by:x.user_id, text:x.text, at:Number(x.at)})), cached:true};
        }
        // rápido: con la cuenta del panel en ISKRA se leen los últimos 80 de una vez (con fotos/PDF/audios); si no se reconoce, la API pública
        if (iskapp.configured() && !input.publicOnly){
          try{ const r = await iskapp.convMessages(String(input.id));
            if (r){ const j = {data:r.data, info:{via:"app", mensajes:r.data.length}};
              MSG_CACHE[input.id] = {lastL, data:j, at:Date.now()};
              const sentA = (await c.query("select user_id, text, extract(epoch from at)*1000 as at from public.iskra_sent where conversation_id=$1 order by at desc limit 200", [String(input.id)])).rows;
              return {data:j, sent:sentA.map(s => ({by:s.user_id, text:s.text, at:Number(s.at)})), via:"app", ...(lead ? {appDebug:r.debug} : {})}; }
          }catch(_){ /* sigue con la API pública */ }
        }
        const all = [], seenIds = new Set(); let cursor = "", pages = 0, info = {};
        while (pages < 6){
          const j = await iskra("GET", `/v1/conversations/${enc(input.id)}/messages?limit=100` + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), null, 10000);
          pages++; arr(j).forEach(m => { const k = m.id || (m.created_at + "|" + (m.text || m.body || "")); if (!seenIds.has(k)){ seenIds.add(k); all.push(m); } });
          cursor = j && j.next_cursor; if (!cursor || j.has_more === false) break;
        }
        const at = m => Date.parse(m.created_at || m.sent_at || m.timestamp || "") || 0;
        all.sort((x, y) => at(x) - at(y));
        const last = all.slice(-80); info = {paginas:pages, mensajes:all.length};
        const j = {data:last.slice().reverse(), info};
        MSG_CACHE[input.id] = {lastL, data:j, at:Date.now()};
        const sent = (await c.query("select user_id, text, extract(epoch from at)*1000 as at from public.iskra_sent where conversation_id=$1 order by at desc limit 200", [String(input.id)])).rows;
        return {data:j, sent:sent.map(s => ({by:s.user_id, text:s.text, at:Number(s.at)}))};
      }
      if (op === "reply"){
        const media = input.media && input.media.url ? input.media : null;
        if (input.template_id){ // plantilla aprobada de ISKRA (puede traer PDF o foto como encabezado): llega como archivo real
          if (!input.conversation_id || !input.idempotency_key) throw Object.assign(new Error("Faltan datos"), {status:400});
          await mustOwn(input.conversation_id);
          const vars = input.variables && typeof input.variables==="object" ? Object.fromEntries(Object.entries(input.variables).map(([k, v]) => [String(k), String(v).slice(0, 1000)])) : {};
          // como la app de ISKRA (template_group_id); si no hay cuenta del panel, la API pública
          const j = iskapp.configured() ? await iskapp.sendTemplate({conversation_id:input.conversation_id, template_group_id:String(input.template_id), variables:vars})
            : await iskra("POST", "/v1/messages/reply", {conversation_id:input.conversation_id, idempotency_key:input.idempotency_key, template_id:String(input.template_id), ...(Object.keys(vars).length ? {variables:vars} : {})});
          LIST_CACHE.at = 0; delete MSG_CACHE[input.conversation_id];
          await c.query("insert into public.iskra_sent (conversation_id, user_id, text) values ($1,$2,$3)", [String(input.conversation_id), me.id, "[plantilla ISKRA] " + String(input.label || "")]);
          await c.query("update public.iskra_owner set last_sender=$2, last_sent_at=now() where conversation_id=$1", [String(input.conversation_id), me.id]);
          return {data:j};
        }
        if (!input.conversation_id || (!input.text && !media) || !input.idempotency_key) throw Object.assign(new Error("Faltan datos"), {status:400});
        await mustOwn(input.conversation_id);
        const text = String(input.text || "").slice(0, 4000);
        const base = {conversation_id:input.conversation_id, idempotency_key:input.idempotency_key};
        let j, mediaErr = null, mediaInfo = null;
        const origin = "https://" + (req.headers["x-forwarded-host"] || req.headers.host || "growth.strikd.ai");
        const cfg = media ? ((await c.query("select data from public.docs where path='config/main'")).rows[0] || {}).data || {} : {};
        const shapeN = 0; // ISKRA confirmó (prueba de 8 formatos): /v1/messages/reply solo acepta text o template_id; ignora archivos
        if (media && iskapp.configured()){ // archivo real por la ruta de la app de ISKRA (send-whatsapp), autorizada por ISKRA
          // igual que la app de ISKRA: archivo + texto en un solo mensaje (el texto va de pie de foto). WhatsApp permite máx. 1024 caracteres de pie
          const isAudio = /^audio\//.test(String(media.type || "")), cap = !isAudio && text.length <= 1024 ? text : "";
          try{ const pm = await publicMedia(media); mediaInfo = {url:pm.url, type:pm.type, como:"archivo"};
            j = await iskapp.sendMedia({conversation_id:input.conversation_id, text:cap, media:pm}); }
          catch(e){ mediaErr = String(e.message || e); if (!text) throw e; }
          if (text && (!cap || mediaErr)) j = await iskra("POST", "/v1/messages/reply", {...base, idempotency_key:base.idempotency_key + "-t", text});
        } else if (media && shapeN){ // formato de archivo confirmado con la prueba
          const pm = await publicMedia(media); mediaInfo = {url:pm.url, type:pm.type, como:"adjunto " + shapeN};
          j = await iskra("POST", "/v1/messages/reply", {...base, ...shapes(pm, text, shapeN)});
        } else if (media && !asAttachment()){ // foto, PDF o nota de voz como link corto dentro del mensaje
          const pm = await publicMedia(media); mediaInfo = {url:pm.url, type:pm.type, como:"link"};
          j = await iskra("POST", "/v1/messages/reply", {...base, text:withLink(text, pm, origin).slice(0, 4000)});
        } else if (media){ // como adjunto (cuando ISKRA lo soporte). El texto va como pie del archivo.
          try{
            const pm = await publicMedia(media); mediaInfo = {url:pm.url, type:pm.type};
            j = await iskra("POST", "/v1/messages/reply", {...base, ...mediaPayload(pm, text)});
          }catch(e){ mediaErr = String(e.message || e) + (e.detail ? " · " + JSON.stringify(e.detail).slice(0, 300) : ""); }
          // si el archivo no pasó, que al menos llegue el texto
          if (mediaErr && text) j = await iskra("POST", "/v1/messages/reply", {...base, idempotency_key:base.idempotency_key + "-t", text});
          if (mediaErr && !text) throw Object.assign(new Error("ISKRA no aceptó el archivo: " + mediaErr), {status:502});
        } else j = await iskra("POST", "/v1/messages/reply", {...base, text});
        LIST_CACHE.at = 0; delete MSG_CACHE[input.conversation_id];
        const label = media ? `${text ? text + " " : ""}[${media.type && media.type.startsWith("audio/") ? "nota de voz" : media.name || "archivo"}]` : text;
        await c.query("insert into public.iskra_sent (conversation_id, user_id, text) values ($1,$2,$3)", [String(input.conversation_id), me.id, label]);
        await c.query("update public.iskra_owner set last_sender=$2, last_sent_at=now() where conversation_id=$1", [String(input.conversation_id), me.id]);
        return {data:j, ...(media ? {media:mediaInfo, mediaErr} : {})};
      }
      if (op === "explore"){ // solo Head: busca en la API de ISKRA cómo mandar archivos (sin mandar mensajes: POST vacíos)
        if (me.role !== "head") throw Object.assign(new Error("Solo el Head."), {status:403});
        const conv = String(input.conversation_id || "");
        const tries = [
          ["GET","/"],["GET","/v1"],["GET","/openapi.json"],["GET","/v1/openapi.json"],["GET","/docs"],["GET","/v1/docs"],["GET","/v1/whoami"],
          ["GET","/v1/templates"],["GET","/v1/media"],["GET","/v1/uploads"],["GET","/v1/files"],["GET","/v1/webhooks"],["GET","/v1/followups"],
          ["POST","/v1/messages/media"],["POST","/v1/messages/send"],["POST","/v1/messages"],["POST","/v1/messages/image"],["POST","/v1/messages/document"],
          ["POST","/v1/messages/attachment"],["POST","/v1/media"],["POST","/v1/uploads"],["POST","/v1/files"],["POST","/v1/messages/reply-media"],
          ["POST","/v1/messages/reply"], ...(conv ? [["POST", `/v1/conversations/${enc(conv)}/messages`], ["POST", `/v1/conversations/${enc(conv)}/media`]] : []),
        ];
        if (input.deep){ // 2a vuelta: lista completa de endpoints y qué pide /v1/messages/send (sin destinatario: no se envía nada)
          const who = await iskra("GET", "/v1/whoami").catch(e => ({error:e.message}));
          const nums = await iskra("GET", "/v1/numbers").catch(e => ({error:e.message}));
          const nid = (arr(nums)[0] || {}).id || (arr(nums)[0] || {}).number_id || "";
          // sin destinatario: solo para ver qué pide y si nuestro número es "reserved sender"
          const probes = [{idempotency_key:"probe-" + Date.now(), sender_number_id:nid}, {idempotency_key:"probe2-" + Date.now(), sender_number_id:nid, header_image_url:"https://example.com/x.png"}];
          const send = await Promise.all(probes.map(async b => { try{ return {b, r:await iskra("POST", "/v1/messages/send", b, 6000)}; }catch(e){ return {b, status:e.status, r:e.detail || e.message}; } }));
          return {data:{numbers:arr(nums).map(n => ({id:n.id || n.number_id, phone:n.phone || n.display_phone_number, name:n.display_name || n.name, reserved:n.reserved, status:n.status})), send}};
        }
        const out = await Promise.all(tries.map(async ([m, path]) => {
          try{ const j = await iskra(m, path, m === "POST" ? {} : null, 6000); return {m, path, status:200, body:JSON.stringify(j).slice(0, 700)}; }
          catch(e){ return {m, path, status:e.status || 0, body:(e.detail ? JSON.stringify(e.detail) : String(e.message)).slice(0, 400)}; }
        }));
        return {data:out};
      }
      if (op === "mediaprobe"){ // solo Head/Manager: manda el mismo archivo en cada formato posible, uno por mensaje
        if (!lead) throw Object.assign(new Error("Solo el Head o el Manager."), {status:403});
        const media = input.media && input.media.url ? input.media : null;
        if (!input.conversation_id || !media) throw Object.assign(new Error("Abre un chat de prueba y adjunta una foto o PDF."), {status:400});
        const pm = await publicMedia(media), out = [], stamp = Date.now().toString(36);
        const list = shapes(pm, "", 0);
        await Promise.all(list.map(async (_, i) => { // en paralelo para no pasar el tiempo límite de Vercel
          const n = i + 1, body = shapes(pm, `Prueba ${n}`, n);
          try{ const r = await iskra("POST", "/v1/messages/reply", {conversation_id:input.conversation_id, idempotency_key:`probe-${stamp}-${n}`, ...body}, 8000); out.push({n, ok:true, respuesta:JSON.stringify(r).slice(0, 300)}); }
          catch(e){ out.push({n, ok:false, error:String(e.message || e), detalle:e.detail ? JSON.stringify(e.detail).slice(0, 300) : ""}); }
        }));
        out.sort((a, b) => a.n - b.n);
        LIST_CACHE.at = 0; delete MSG_CACHE[input.conversation_id];
        return {data:out, url:pm.url};
      }
      if (op === "interest"){ // marcar (o quitar) que el chat muestra interés
        await mustOwn(input.id);
        await c.query(input.undo ? "update public.iskra_owner set interest_at=null, interest_by=null where conversation_id=$1" : "update public.iskra_owner set interest_at=now(), interest_by=$2 where conversation_id=$1",
          input.undo ? [String(input.id)] : [String(input.id), me.id]);
        LIST_CACHE.at = 0; return {ok:true};
      }
      if (op === "noreply"){ // "no necesita respuesta": su último mensaje ya no cuenta como pendiente ni en el tiempo de respuesta (si vuelve a escribir, cuenta otra vez)
        await mustOwn(input.id); const id = String(input.id);
        if (input.undo){ await c.query("update public.iskra_owner set noreply_at=null, noreply_by=null where conversation_id=$1", [id]); return {ok:true}; }
        await c.query("update public.iskra_owner set noreply_at=now(), noreply_by=$2 where conversation_id=$1", [id, me.id]);
        await c.query(`insert into public.iskra_wait (conversation_id, since, last_seen) values ($1, null, now())
          on conflict (conversation_id) do update set since=null, last_seen=greatest(coalesce(public.iskra_wait.last_seen, now()), now())`, [id]).catch(() => {});
        LIST_CACHE.at = 0; return {ok:true};
      }
      if (op === "discard"){ // descartar (o regresar) una conversación: deja de salir en la bandeja
        await mustOwn(input.id);
        await c.query(input.undo ? "update public.iskra_owner set discarded_at=null, discarded_by=null where conversation_id=$1"
          : "update public.iskra_owner set discarded_at=now(), discarded_by=$2 where conversation_id=$1", input.undo ? [String(input.id)] : [String(input.id), me.id]);
        return {ok:true};
      }
      if (op === "assign"){
        if (!lead) throw Object.assign(new Error("Solo el Head o el Manager reasignan."), {status:403});
        await c.query(`insert into public.iskra_owner (conversation_id, owner, assigned_by) values ($1,$2,'manual')
          on conflict (conversation_id) do update set owner=excluded.owner, assigned_by='manual', assigned_at=now(), escalated_at=null`, [String(input.id), input.owner || null]);
        OWN_CACHE[String(input.id)] = input.owner || null;
        return {ok:true};
      }
      if (op === "escalate"){
        await mustOwn(input.id);
        const m = (await c.query("select id from public.app_users where role='manager' and active limit 1")).rows[0]
          || (await c.query("select id from public.app_users where role='head' and active limit 1")).rows[0];
        await c.query("update public.iskra_owner set owner=$2, escalated_at=now(), assigned_by='escalado' where conversation_id=$1", [String(input.id), m ? m.id : null]);
        OWN_CACHE[String(input.id)] = m ? m.id : null;
        return {ok:true};
      }
      if (op === "aisummary"){ if (!lead) throw Object.assign(new Error("Solo el Head o el Manager."), {status:403}); const d = await aireply.summary(c); d.stall = await stall.summary(c).catch(() => null); return {data:d}; }
      if (op === "stats"){
        if (!lead) throw Object.assign(new Error("Solo el Head o el Manager ven los resultados."), {status:403});
        const q = new URLSearchParams(); ["from","to","period"].forEach(k => { if (input[k]) q.set(k, String(input[k])); });
        const [sum, acc] = await Promise.all([iskra("GET", "/v1/stats/summary" + (q.toString() ? "?" + q : "")), iskra("GET", "/v1/campaigns/accounting" + (q.toString() ? "?" + q : "")).catch(e => ({error:e.message}))]);
        return {data:{summary:sum, campaigns:acc}};
      }
      if (op === "wa_report"){ // WhatsApp outreach: generales y por campaña (los meets y publicados los cruza el panel con sus prospectos)
        if (!lead) throw Object.assign(new Error("Solo el Head o el Manager ven los resultados."), {status:403});
        if (!input.fresh && REP_CACHE.data && Date.now() - REP_CACHE.at < 5*60e3) return REP_CACHE.data;
        const [sum, acc] = await Promise.all([iskra("GET", "/v1/stats/summary").catch(e => ({error:e.message})), iskra("GET", "/v1/campaigns/accounting").catch(e => ({error:e.message}))]);
        const all = {}; let cursor = "", pages = 0;
        while (pages < 25){ const j = await iskra("GET", "/v1/conversations?limit=100" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), null, 10000).catch(() => null); if (!j) break; pages++;
          arr(j).forEach(cv => { all[String(cv.id || cv.conversation_id)] = cv; }); cursor = j.next_cursor; if (!cursor || j.has_more === false) break; }
        const convs = Object.values(all), ids = convs.map(cv => String(cv.id || cv.conversation_id));
        const seenR = {}, ownR = {};
        if (ids.length){ (await c.query("select conversation_id, replied, real from public.iskra_seen where conversation_id = any($1)", [ids]).catch(() => ({rows:[]}))).rows.forEach(r => seenR[r.conversation_id] = r);
          (await c.query("select conversation_id, replied_at from public.iskra_owner where conversation_id = any($1)", [ids]).catch(() => ({rows:[]}))).rows.forEach(r => ownR[r.conversation_id] = r); }
        const campOf = cv => { const k = Object.keys(cv).find(x => /campaign/i.test(x) && cv[x] != null && cv[x] !== ""); if (!k) return [null, null]; const v = cv[k];
          if (typeof v === "object") return [String(v.id || v.campaign_id || v.name || ""), String(v.name || v.title || v.id || "")];
          const nk = Object.keys(cv).find(x => /campaign.*name|campaign_title/i.test(x)); return [String(cv.campaign_id || v), String((nk && cv[nk]) || v)]; };
        const nOf = cv => { const k = Object.keys(cv).find(x => /(messages?_count|total_messages|message_count|messages_sent|sent_count)/i.test(x) && Number(cv[x]) >= 0); return k ? Number(cv[k]) : null; };
        const out = convs.map(cv => { const id = String(cv.id || cv.conversation_id), [camp, campName] = campOf(cv), sn = seenR[id], ow = ownR[id];
          const lm = cv.last_message || {}, lastIn = /^in/i.test(String(lm.direction || cv.last_message_direction || ""));
          return {id, phone:digits(cv.contact_phone || convPhone(cv)), camp, campName, n:nOf(cv), at:Date.parse(cv.created_at || cv.first_message_at || cv.started_at || cv.inserted_at || "") || null,
            replied:!!((sn && (sn.real === true || (sn.real == null && sn.replied))) || (ow && ow.replied_at) || lastIn || Number(cv.unread_count || 0) > 0)}; });
        const r = {data:{summary:sum, campaigns:acc, convs:out, keys:{conv:Object.keys(convs[0] || {}).slice(0, 40)}, pages}};
        REP_CACHE.at = Date.now(); REP_CACHE.data = r; return r;
      }
      if (op === "resp_stats"){ // tiempo de respuesta por persona (el AM solo recibe el suyo y el del equipo)
        const from = Number(input.from) || Date.now() - 7 * 864e5, to = Number(input.to) || Date.now();
        const st = await resptime.stats(c, from, to);
        if (!lead){ const mine = st.people[viewId] || null; return {data:{from, to, team:st.team, people:mine ? {[viewId]:mine} : {}}}; }
        return {data:st};
      }
      if (op === "numbers") return {data:await iskra("GET", "/v1/numbers")};
      if (op === "templates" && !input.fresh && TPL_CACHE.data && Date.now() - TPL_CACHE.at < 10*60e3) return TPL_CACHE.data;
      if (op === "templates"){ // ISKRA llama "templates" a sus Quick replies. Si no regresa lista, probar variantes y devolver qué contestó cada una
        const hasArr = (o, d) => Array.isArray(o) ? o.length > 0 : (o && typeof o==="object" && d < 4 ? Object.values(o).some(v => hasArr(v, d+1)) : false);
        const tried = [];
        // probado: Quick replies no salen por la API (13 variantes). /v1/templates solo regresa los moldes de Meta cuando se le pasa el número
        for (const path of ["/v1/templates"]){
          try{ const j = await iskra("GET", path); if (hasArr(j, 0)) return (TPL_CACHE.at = Date.now(), TPL_CACHE.data = {data:j, from:path, tried});
            tried.push({path, ok:true, body:JSON.stringify(j).slice(0, 400)}); }
          catch(e){ tried.push({path, ok:false, status:e.status || 0, body:String(e.message).slice(0, 200)}); }
        }
        try{ // ¿las filtra por número que envía?
          const nj = await iskra("GET", "/v1/numbers"), arr = Array.isArray(nj) ? nj : (nj.data || nj.numbers || []);
          // todas las páginas (next_cursor) de todos los números, sin repetir
          const all = new Map(); let okPath = "";
          for (const n of arr.slice(0, 5)){ const nid = n.id || n.number_id; if (!nid) continue;
            for (const q of (okPath ? [okPath] : ["number_id", "sender_number_id"])){
              let cursor = "", pages = 0, got = 0;
              try{
                while (pages < 10){ const path = `/v1/templates?${q}=${encodeURIComponent(nid)}&limit=100` + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
                  const j = await iskra("GET", path); pages++;
                  const list = Array.isArray(j) ? j : (j.data || j.templates || []);
                  list.forEach(t => { const k = t.id || t.name; if (k && !all.has(k)) all.set(k, t); }); got += list.length;
                  cursor = j && j.next_cursor; if (!cursor || j.has_more === false) break; }
                if (got){ okPath = q; break; } tried.push({path:`/v1/templates?${q}=…`, ok:true, body:"vacío"});
              }catch(e){ tried.push({path:`/v1/templates?${q}=…`, ok:false, status:e.status || 0, body:String(e.message).slice(0, 200)}); }
            } }
          if (all.size){ let bodies = {}; if (iskapp.configured()) bodies = await iskapp.moldBodies().catch(() => ({})); // texto del molde para la vista previa
            const list = [...all.values()].map(t => (t.body || !bodies[t.name]) ? t : {...t, body:bodies[t.name]});
            return (TPL_CACHE.at = Date.now(), TPL_CACHE.data = {data:{data:list}, from:`/v1/templates?${okPath}= (${all.size}, todas las páginas)`, tried}); }
        }catch(_){}
        return {data:[], tried};
      }
      throw Object.assign(new Error("Operación no permitida"), {status:400});
    });
    res.json({configured:true, ...out});
  }catch(err){ res.status(err.status || 502).json({configured:true, error:String(err.message || err), detail:err.detail}); }
};
