// Puente con ISKRA (WhatsApp). La llave vive solo en Vercel (ISKRA_API_KEY); el navegador nunca la ve.
// Un solo número de STRIKD, varias personas: cada conversación tiene dueño.
//  · Head y Creator Partnerships Manager ven todas; el Account Manager solo las suyas (lo filtra el servidor).
//  · Conversación nueva → se asigna sola: opción "load" (menos carga) u opción "best" (mejores resultados, 4 semanas).
//  · Cada envío queda registrado con quién lo mandó. Envíos siempre por clic de una persona, con idempotency_key.
const { withPg, userFromReq } = require("../lib/google");
const { publicMedia, mediaPayload, asAttachment, withLink, shapes } = require("../lib/iskmedia");
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
    if (!r.ok) throw Object.assign(new Error((j && (j.error || j.message)) || ("ISKRA " + r.status)), {status:r.status, detail:j});
    return j;
  }catch(e){ if (e.name === "AbortError") throw Object.assign(new Error("ISKRA tardó demasiado"), {status:504}); throw e; }
  finally{ clearTimeout(to); }
}
// Lista de conversaciones: primera página cada 10 s; hasta 4 páginas cada 60 s (por si la actividad nueva no viene arriba).
// Además, los mensajes entrantes de las últimas 2 h (con fecha, para que ISKRA no tarde) para no perder ninguno nuevo.
let LIST_CACHE = {at:0, deepAt:0, data:null, p:null, info:{}};
const MSG_CACHE = {}, OWN_CACHE = {};
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
create table if not exists public.iskra_seen (conversation_id text primary key, last_at timestamptz, last_dir text, replied boolean default false, checked_at timestamptz);
alter table public.iskra_seen enable row level security;
create table if not exists public.iskra_sent (id bigserial primary key, conversation_id text, user_id uuid, text text, at timestamptz default now());
alter table public.iskra_owner enable row level security; alter table public.iskra_sent enable row level security;`;

// Elige dueño para conversaciones nuevas. Carga todo una sola vez por petición (rápido aunque lleguen muchas juntas).
function makePicker(c, mode){
  let ready = null;
  const load0 = async () => {
    const phones = {};
    (await c.query(`select split_part(path,'/',2) as uid, right(regexp_replace(coalesce(data->>'phone',''),'\\D','','g'),10) as d from public.docs
      where (path like 'meets/%/items/%' or path like 'meets/%/waleads/%') and coalesce(data->>'phone','') <> ''`)).rows.forEach(r => { if (r.d && !phones[r.d]) phones[r.d] = r.uid; });
    const users = (await c.query("select id, role from public.app_users where active")).rows;
    const active = new Set(users.map(u => u.id));
    const ams = users.filter(u => u.role === "am").map(u => u.id);
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
  const op = body.op, input = body.input || {}, lead = me.role !== "am";
  // Ruta rápida para el chat abierto: solo lo nuevo desde cierta hora (sin base de datos si ya sabemos que es suyo).
  if (op === "tail"){
    try{
      const id = String(input.id || ""); if (!id) return res.status(400).json({error:"Falta id"});
      if (!lead && OWN_CACHE[id] !== me.id){
        const ok = await withPg(async c => (await c.query("select owner from public.iskra_owner where conversation_id=$1", [id])).rows[0]);
        if (!ok || ok.owner !== me.id) return res.status(403).json({error:"Esta conversación es de otra persona."});
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
      const mustOwn = async id => { const o = await ownerOf(id); if (!lead && (!o || o.owner !== me.id)) throw Object.assign(new Error("Esta conversación es de otra persona."), {status:403}); return o; };
      if (op === "whoami"){ const j = await iskra("GET", "/v1/whoami"); return {data:j, me:{id:me.id, role:me.role}}; }
      if (op === "conversations"){
        // Solo conversaciones donde el prospecto YA contestó al menos una vez.
        // ISKRA no dice en la lista quién escribió el último mensaje, así que:
        //  · unread_count > 0 → el prospecto escribió;
        //  · si cambió la conversación (last_message_at), leemos sus mensajes (máx. 8 por vuelta) y guardamos lo que vimos.
        const T = {}, t0 = Date.now();
        const list = await iskList(); T.iskra = Date.now() - t0;
        const ids = list.map(convId).filter(Boolean), byId = {};
        list.forEach(cv => { const id = convId(cv); if (id) byId[id] = cv; });
        const known = {}, seen = {};
        if (ids.length){
          (await c.query("select * from public.iskra_owner where conversation_id = any($1)", [ids])).rows.forEach(o => known[o.conversation_id] = o);
          (await c.query("select * from public.iskra_seen where conversation_id = any($1)", [ids])).rows.forEach(o => seen[o.conversation_id] = o);
        }
        const lastAt = cv => cv.last_message_at || (cv.last_message && cv.last_message.created_at) || cv.updated_at || "";
        const stale = id => { const sn = seen[id]; return !sn || !sn.last_at || Date.parse(lastAt(byId[id])) > new Date(sn.last_at).getTime() + 1000; };
        const toCheck = ids.filter(id => stale(id) && !(Number(byId[id].unread_count || 0) > 0 && known[id] && known[id].replied_at)).slice(0, 8);
        await Promise.all(toCheck.map(async id => {
          try{
            const ms = arr(await iskra("GET", `/v1/conversations/${enc(id)}/messages?limit=30`));
            const isIn = m => /^(in|inbound|incoming|received|lead)/i.test(String(m.direction || m.dir || (m.from_me===false ? "in" : m.from_me ? "out" : "") || ""));
            const at = m => Date.parse(m.created_at || m.sent_at || m.timestamp || "") || 0;
            const sorted = ms.slice().sort((x, y) => at(y) - at(x));
            const replied = ms.some(isIn), lastDir = sorted[0] ? (isIn(sorted[0]) ? "in" : "out") : null;
            seen[id] = {conversation_id:id, last_at:lastAt(byId[id]) || null, last_dir:lastDir, replied};
            await c.query(`insert into public.iskra_seen (conversation_id, last_at, last_dir, replied, checked_at) values ($1,$2,$3,$4,now())
              on conflict (conversation_id) do update set last_at=excluded.last_at, last_dir=excluded.last_dir, replied=public.iskra_seen.replied or excluded.replied, checked_at=now()`,
              [id, lastAt(byId[id]) || null, lastDir, replied]);
          }catch(_){ /* se reintenta en la siguiente vuelta */ }
        }));
        T.mensajes = Date.now() - t0;
        const replied = id => !!((known[id] && known[id].replied_at) || (seen[id] && seen[id].replied) || Number(byId[id].unread_count || 0) > 0);
        const cfg = (await c.query("select data from public.docs where path='config/main'")).rows[0];
        const mode = cfg && cfg.data && cfg.data.iskAssign === "best" ? "best" : "load";
        const out = [], pick = makePicker(c, mode);
        for (const id of ids){
          if (!replied(id)) continue;
          const cv = byId[id], sn = seen[id];
          // dirección del último mensaje: lo que vimos, o "entrante" si hay sin leer, o "saliente" si alguien del equipo contestó después
          let dir = sn && !stale(id) ? sn.last_dir : null;
          if (Number(cv.unread_count || 0) > 0) dir = "in";
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
          }
          OWN_CACHE[id] = o.owner;
          if (lead || o.owner === me.id) out.push({...norm, _strikd:{owner:o.owner, assignedBy:o.assigned_by, escalatedAt:o.escalated_at, lastSender:o.last_sender, lastSentAt:o.last_sent_at, discardedAt:o.discarded_at, discardedBy:o.discarded_by}});
        }
        T.total = Date.now() - t0; res.setHeader("server-timing", `iskra;dur=${T.iskra}, total;dur=${T.total}`);
        const debug = lead ? {tiempos_ms:T, lista:LIST_CACHE.info, conversaciones_en_lista:list.length, revisadas_esta_vuelta:toCheck.length, pendientes_de_revisar:ids.filter(stale).length - toCheck.length, con_respuesta:out.length, ejemplo_conversacion:list[0] || null} : undefined;
        return {data:{data:out}, mode, debug};
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
        if (!input.conversation_id || (!input.text && !media) || !input.idempotency_key) throw Object.assign(new Error("Faltan datos"), {status:400});
        await mustOwn(input.conversation_id);
        const text = String(input.text || "").slice(0, 4000);
        const base = {conversation_id:input.conversation_id, idempotency_key:input.idempotency_key};
        let j, mediaErr = null, mediaInfo = null;
        const origin = "https://" + (req.headers["x-forwarded-host"] || req.headers.host || "growth.strikd.ai");
        const cfg = media ? ((await c.query("select data from public.docs where path='config/main'")).rows[0] || {}).data || {} : {};
        const shapeN = Number(cfg.iskMediaShape) || 0;
        if (media && shapeN){ // formato de archivo confirmado con la prueba
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
      if (op === "stats"){
        if (!lead) throw Object.assign(new Error("Solo el Head o el Manager ven los resultados."), {status:403});
        const q = new URLSearchParams(); ["from","to","period"].forEach(k => { if (input[k]) q.set(k, String(input[k])); });
        const [sum, acc] = await Promise.all([iskra("GET", "/v1/stats/summary" + (q.toString() ? "?" + q : "")), iskra("GET", "/v1/campaigns/accounting" + (q.toString() ? "?" + q : "")).catch(e => ({error:e.message}))]);
        return {data:{summary:sum, campaigns:acc}};
      }
      if (op === "numbers") return {data:await iskra("GET", "/v1/numbers")};
      if (op === "templates") return {data:await iskra("GET", "/v1/templates")};
      throw Object.assign(new Error("Operación no permitida"), {status:400});
    });
    res.json({configured:true, ...out});
  }catch(err){ res.status(err.status || 502).json({configured:true, error:String(err.message || err), detail:err.detail}); }
};
