// Secuencia de emails a influencers de la Lista de Mich (Alek, 9 nov 2026):
//  Approach 1 (día 0) micropitch con video → Approach 2 (día 3, mismo hilo) → Approach 3 (día 7, mismo hilo) → DM de Mich (día 10).
// A quién: perfiles con email que no son 👑 Top tier ni 🤝 Contacto directo, ni UGC, ni marcados "No enviar", ✍️ Correo personalizado,
// 🚫 No enviar nada o ⚔️ Competidor directo (tags que pone el Head desde Emails por autorizar).
//  - Pendientes (Mich no les ha escrito): el approach 1 sale en cuanto haya cupo.
//  - Ya contactados por DM: el approach 1 sale 10 días después del DM (como antes) y no llevan DM al final.
// Los pendientes entran solo con la secuencia encendida (config/main.mailSeq.on, en Ajustes → Emails automáticos).
// Se detiene si contestan, piden «baja», rebota, agendan meet o los marcan Top tier / Contacto directo.
// Sale de las 5 cuentas de envío (gmail_tokens key seq1..seq5); cada perfil se queda con la misma cuenta toda la secuencia.
// Si no hay cuentas de envío, del Gmail del AM autorizado o del correo general (como antes).
// Cupo por cuenta al día (incluye seguimientos; primero salen los seguimientos): calentamiento 5 → 10 → 15 → 20 por semana desde su primer envío.
// De lunes a jueves de 9 am a 6 pm (Cancún), repartidos en el día (máx. 1 por cuenta cada 5 min).
const gmail = require("./gmail");
const { sendTo } = require("./push");
const { sign } = require("./google");
const OFF = 5 * 3600e3, DAY = 864e5, LIMIT = 20, H_FROM = 9, H_TO = 18;
const WAIT = {2:3 * DAY, 3:4 * DAY, dm:3 * DAY, dmFirst:10 * DAY};
const FOOTER = "\n\n—\nSi prefieres que no te volvamos a escribir, responde «baja» y listo.";
const ORIGIN = process.env.PUBLIC_ORIGIN || "https://growth.strikd.ai";
const HALT = false; // true = envíos detenidos a mano (se usó el 10 nov 2026 13:26–13:33)
const SEQ_KEYS = ["seq1", "seq2", "seq3", "seq4", "seq5"];

function inWindow(now){
  const l = new Date(now - OFF), d = l.getUTCDay(), h = l.getUTCHours();
  return d >= 1 && d <= 4 && h >= H_FROM && h < H_TO;   // lunes a jueves (Alek, 9 nov 2026)
}
// {nombre}, [Nombre], {Nombre}… (como lo escriban) → nombre del influencer
const fill = (t, v) => String(t || "").replace(/[{\[]\s*nombre\s*[}\]]/gi, v.nombre || "").replace(/[{\[]\s*am\s*[}\]]/gi, v.am || "").replace(/[{\[]\s*video\s*[}\]]/gi, "{video}").replace(/[ \t]+([!,.?:])/g, "$1").replace(/(Hola|Hey|Qué tal)\s*,?\s*([:!,])/gi, "$1$2").trim();
async function patchVip(c, path, patch){
  await c.query("update public.docs set data = data || $2::jsonb, version = version + 1, updated_at = now() where path = $1", [path, JSON.stringify(patch)]);
}
// cupo de calentamiento según cuántos días lleva mandando esa cuenta
// (Alek, 10 nov 2026): empieza en 10, luego 15 y desde la 3ª semana 20
function quotaFor(firstAt, now){
  if (!firstAt) return 10;
  const d = (now - firstAt) / DAY;
  return d < 7 ? 10 : d < 14 ? 15 : LIMIT;
}
// link con firma para contar quién abre el video (/v → api/f)
const trackUrl = (path, step) => { const p = path.split("/"), t = `${p[1]}.${p[3]}.${step}`; return `${ORIGIN}/v?t=${encodeURIComponent(t + "." + sign(t).slice(0, 16))}`; };
const escH = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const linkify = s => s.replace(/https?:\/\/[^\s<]+/g, u => `<a href="${u}">${u}</a>`);
function thumbOf(seq){
  if (seq.thumb) return /^https?:/i.test(seq.thumb) ? seq.thumb : `${ORIGIN}/_blob/${seq.thumb}`;
  const yt = String(seq.video || "").match(/(?:youtu\.be\/|v=|shorts\/|embed\/)([\w-]{11})/);
  return yt ? `https://img.youtube.com/vi/${yt[1]}/hqdefault.jpg` : "";
}
// arma texto y HTML; {video} marca dónde va el video (en el approach 1 va al final si no lo pusieron)
// sig = firma de la cuenta en Gmail (HTML). La línea de «baja» solo si se activó en Ajustes (mailSeq.optout).
const sigText = h => String(h || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, "\n\n").trim();
// El video va como link directo a YouTube, visible ("youtube.com/…"), para que se vea confiable (Alek, 9 nov 2026):
// sin miniatura propia ni link nuestro de por medio; Gmail muestra solo su vista previa de YouTube al final.
// (Ya no se cuenta quién lo abre: con link directo no se puede.)
const ytId = u => (String(u || "").match(/(?:youtu\.be\/|v=|shorts\/|embed\/|live\/)([\w-]{11})/) || [])[1] || "";
function videoUrl(seq){ const id = ytId(seq.video); return id ? `https://www.youtube.com/watch?v=${id}` : String(seq.video || ""); }
function compose(body, step, seq, path, noTrack, sig){
  const has = /\{video\}/.test(body), want = !!seq.video && (has || step === 1);
  const url = want ? videoUrl(seq) : "", label = seq.videoLabel || "Ver video en YouTube";
  const parts = String(body).split("{video}");
  const vText = url ? `\n\n${label}: ${url}\n\n` : "";
  const vHtml = url ? `<div>${escH(label)}: <a href="${escH(url)}">${escH(url.replace(/^https?:\/\/(www\.)?/, ""))}</a></div><div><br></div>` : "";
  const segs = want && !has ? [parts.join(""), ""] : parts;
  const foot = seq.optout ? FOOTER : "", st = sigText(sig);
  const text = segs.map(s => s.trim()).join(vText).replace(/\n{3,}/g, "\n\n").trim() + (st ? "\n\n-- \n" + st : "") + foot;
  // HTML como lo escribe Gmail: un <div> por línea, sin fuentes ni estilos propios
  const lines = t => t.trim() ? t.trim().split("\n").map(l => l.trim() ? `<div>${linkify(escH(l))}</div>` : "<div><br></div>").join("") + "<div><br></div>" : "";
  const htmlBody = segs.map(lines).join(vHtml);
  const html = `<div dir="ltr">${htmlBody}${sig ? `<div dir="ltr" class="gmail_signature">${sig}</div>` : ""}${seq.optout ? `<div><br></div><div style="color:#777">Si prefieres que no te volvamos a escribir, responde «baja» y listo.</div>` : ""}</div>`;
  return {text, html};
}
// qué toca para este perfil (0 = nada todavía)
// los pendientes (sin DM de Mich) solo entran cuando el Head enciende la secuencia (config/main.mailSeq.on)
function nextStep(x, now, seqOn){
  const pend = (x.status || "nuevo") === "nuevo";
  if (pend && !x.email1At && !seqOn) return 0;
  if (!x.email1At){ const cAt = Number(x.contactedAt || x.statusAt) || 0; return pend || (cAt && now >= cAt + WAIT.dmFirst) ? 1 : 0; }
  if (!x.email2At) return now >= Number(x.email1At) + WAIT[2] ? 2 : 0;
  if (!x.email3At) return now >= Number(x.email2At) + WAIT[3] ? 3 : 0;
  return 0;
}

async function run(c, opts){
  const now = Date.now();
  // los envíos solo de lunes a jueves de 9 a 6; las respuestas se revisan todos los días (cada 15 min fuera de ese horario)
  // "Enviar ya": un lote autorizado con sendNow sale fuera de horario, 1 por cuenta cada minuto, respetando el cupo del día
  const force = !!(opts && opts.force), mi = new Date(now).getUTCMinutes();
  const rush = !force && !HALT && !!(await c.query(`select 1 from public.docs where parent='mailBatch' and data->>'status'='approved' and data->>'sendNow'='true' and data->>'date' >= $1 limit 1`, [dayKey(now)]).catch(() => ({rows:[]}))).rows[0];
  const sendOk = force || inWindow(now) || rush, fast = rush && mi % 5 !== 0;
  if (!force && !rush && (mi % 5 !== 0 || (!sendOk && mi % 15 !== 0))) return null;
  await gmail.ensure(c);
  await c.query("create table if not exists public.email_clicks (id bigserial primary key, uid text, vip_id text, step int, at timestamptz default now()); alter table public.email_clicks enable row level security;").catch(() => {});
  const cfg = ((await c.query("select data from public.docs where path='config/main'")).rows[0] || {}).data || {};
  const seq = cfg.mailSeq || {};
  const seqOn = seq.on === true;
  const tpls = (await c.query("select id, data from public.docs where parent='emailTpl'")).rows.map(r => ({id:r.id, ...(r.data || {})})).filter(t => t.active !== false && (t.subject || Number(t.step) > 1) && t.body);
  const tokens = {}; (await c.query("select key, email from public.gmail_tokens")).rows.forEach(r => tokens[r.key] = r.email);
  const out = {enviados:0, respuestas:0, dm:0};
  if (!Object.keys(tokens).length) return null;
  const seqKeys = SEQ_KEYS.filter(k => tokens[k]);
  const roles = {}; (await c.query("select path, data from public.docs where parent='roles'")).rows.forEach(r => roles[r.path.split("/")[1]] = r.data || {});
  const names = {}; (await c.query("select id, name, email from public.app_users")).rows.forEach(r => names[r.id] = (r.name || r.email || "").split(" ")[0]);
  const day0ms = Date.parse(new Date(now - OFF).toISOString().slice(0, 10) + "T00:00:00Z") + OFF, day0 = new Date(day0ms).toISOString();
  const sentToday = {}; (await c.query("select sender, count(*)::int n from public.email_log where at >= $1 and status <> 'error' group by sender", [day0])).rows.forEach(r => sentToday[r.sender] = r.n);
  const firstAt = {}; (await c.query("select sender_email, min(at) a from public.email_log where status <> 'error' group by sender_email")).rows.forEach(r => firstAt[r.sender_email] = new Date(r.a).getTime());
  const used = {}; (await c.query("select tpl, count(*)::int n from public.email_log group by tpl")).rows.forEach(r => used[r.tpl] = r.n);
  const tok = {}; const tokenOf = async k => (tok[k] ||= await gmail.tokenFor(c, k));
  // cuánto puede llevar cada cuenta a esta hora: el cupo se reparte a lo largo de la jornada
  const frac = Math.min(1, Math.max(0, (now - (day0ms + H_FROM * 3600e3)) / ((H_TO - H_FROM) * 3600e3)));
  const capNow = k => { const q = quotaFor(firstAt[tokens[k]], now); return (opts && opts.force) ? q : Math.min(q, Math.max(1, Math.ceil(q * frac))); };

  // 1) revisar respuestas (hasta 15 hilos por vuelta, los que llevan más sin revisar)
  const watching = fast ? [] : (await c.query(`select path, data from public.docs where path like 'meets/%/vip/%' and data ? 'email1Thread'
    and not (data ? 'emailRepliedAt') and not (data ? 'emailOptout') and coalesce((data->>'email1At')::bigint, 0) > $1
    order by coalesce((data->>'emailCheckedAt')::bigint, 0) asc limit 15`, [now - 40 * DAY])).rows;
  for (const r of watching){
    const x = r.data || {}, k = x.email1Sender, t = k && await tokenOf(k);
    if (!t){ await patchVip(c, r.path, {emailCheckedAt:now}); continue; }
    try{
      const rep = await gmail.threadReply(t.token, x.email1Thread);
      if (rep.replied){
        const optout = /\bbaja\b/i.test(rep.snippet || ""), patch = {emailRepliedAt:now, emailReplySnippet:String(rep.snippet || "").slice(0, 300), emailCheckedAt:now,
          ...(rep.bounce ? {emailBounced:true} : {}), ...(optout ? {emailOptout:true} : {})};
        await patchVip(c, r.path, patch);
        await c.query("update public.email_log set status=$2 where thread_id=$1", [x.email1Thread, rep.bounce ? "bounce" : optout ? "optout" : "replied"]);
        if (!rep.bounce && !optout){
          const u = r.path.split("/")[1];
          await sendTo(c, [u], {title:`✉️ ${x.prospect || "Un influencer"} contestó el email`, body:String(rep.snippet || "Te contestó").slice(0, 160), url:"/?tab=hoy", tag:"email-" + r.path}).catch(() => {});
        }
        out.respuestas++;
      } else await patchVip(c, r.path, {emailCheckedAt:now});
    }catch(e){ await patchVip(c, r.path, {emailCheckedAt:now}); }
  }

  // 2) a quienes ya les llegaron los 3 approaches sin respuesta: le toca el DM a Mich (día 10)
  const dmRows = fast ? [] : (await c.query(`select path, data from public.docs where path like 'meets/%/vip/%' and data ? 'email3At' and not (data ? 'dmDueAt')
    and not (data ? 'emailRepliedAt') and coalesce(data->>'status','nuevo')='nuevo' and coalesce(data->>'meetId','')='' and (data->>'email3At')::bigint < $1`, [now - WAIT.dm])).rows;
  const dmBy = {};
  for (const r of dmRows){ await patchVip(c, r.path, {dmDueAt:now}); const u = r.path.split("/")[1]; dmBy[u] = (dmBy[u] || 0) + 1; out.dm++; }
  for (const [u, n] of Object.entries(dmBy))
    await sendTo(c, [u], {title:`💬 ${n} influencer${n === 1 ? "" : "s"} para DM`, body:"No contestaron los 3 emails. Ya salen hasta arriba en tus Pendientes.", url:"/?tab=mich", tag:"dm-due"}).catch(() => {});

  if (!sendOk) return out.respuestas || out.dm ? out : null;
  // ALTO (Alek, 10 nov 2026 13:26): no sale ningún email hasta que se quite esta línea. Las respuestas se siguen revisando.
  if (HALT) return out.respuestas || out.dm ? out : null;
  // 3a) con autorización (por defecto): solo sale el lote del día que el Head autorizó (mailBatch/AAAA-MM-DD)
  if (seq.approval !== false){
    if (seqOn) await sendBatch(c, {now, seq, tokens, tokenOf, names, out, day0ms, sentToday, firstAt, rush});
    // y a las 5 pm se prepara el lote del siguiente día hábil para que el Head lo revise
    const l = new Date(now - OFF);
    if (seqOn && l.getUTCHours() === 17 && l.getUTCMinutes() < 10){ const d = nextBizDay(now);
      if (!(await c.query("select 1 from public.docs where path=$1", ["mailBatch/" + d])).rows[0]){ const b = await plan(c, d); if (b && b.items.length) await notifyHead(c, b); } }
    return out.enviados || out.respuestas || out.dm ? out : null;
  }
  // 3) sin autorización: mandar los que tocan: primero seguimientos (3, 2), luego nuevos por más seguidores
  if (!tpls.length) return out.enviados || out.respuestas || out.dm ? out : null;
  const cands = (await c.query(`select path, data from public.docs where path like 'meets/%/vip/%' and coalesce(data->>'status','nuevo') in ('nuevo','contactado')
    and coalesce(data->>'meetId','')='' and coalesce(data->>'email','')<>'' and not (data ? 'emailOptout') and not (data ? 'emailRepliedAt') and not (data ? 'emailBounced')
    and not (data ? 'email3At') and coalesce((data->>'emailSkip')::boolean, false) = false and coalesce((data->>'top')::boolean, false) = false
    and coalesce((data->>'direct')::boolean, false) = false and coalesce((data->>'personal')::boolean, false) = false and coalesce((data->>'noContact')::boolean, false) = false and coalesce((data->>'competitor')::boolean, false) = false and coalesce(data->>'kind','') <> 'ugc'`)).rows;
  const list = cands.map(r => ({r, step:nextStep(r.data || {}, now, seqOn)})).filter(o => o.step)
    .sort((a, b) => (b.step - a.step) || ((Number(b.r.data.followers) || 0) - (Number(a.r.data.followers) || 0)));
  const runSent = {};
  for (const {r, step} of list){
    const x = r.data || {}, u = r.path.split("/")[1];
    if ((Number(x.emailErrorAt) || 0) > now - DAY) continue; // si falló, se reintenta al día siguiente
    const opts2 = tpls.filter(t => Number(t.step) === step); if (!opts2.length) continue;
    // de quién sale: seguimientos, de la misma cuenta del approach 1; nuevos, la cuenta de envío con menos envíos hoy
    let key;
    if (step > 1) key = x.email1Sender && tokens[x.email1Sender] ? x.email1Sender : null;
    else if (seqKeys.length) key = seqKeys.filter(k => !runSent[k] && (sentToday[k] || 0) < capNow(k)).sort((a, b) => (sentToday[a] || 0) - (sentToday[b] || 0))[0] || null;
    else key = (roles[u] || {}).canEmail && tokens[u] ? u : (tokens.general ? "general" : null);
    if (!key || (sentToday[key] || 0) >= capNow(key) || runSent[key]) continue;
    runSent[key] = 1;
    const t = await tokenOf(key); if (!t) continue;
    const tpl = opts2.slice().sort((a, b) => (used[a.id] || 0) - (used[b.id] || 0))[0];
    const person = SEQ_KEYS.includes(key) || key === "general" ? "" : names[key] || "";
    const idn = await gmail.sendAs(t.token, t.email), am = person || idn.displayName || "", v = {nombre:String(x.prospect || "").split(" ")[0], am};
    const subject = step > 1 && x.email1Subject ? "Re: " + String(x.email1Subject).replace(/^re:\s*/i, "") : fill(tpl.subject, v);
    const m = compose(fill(tpl.body, v), step, seq, r.path, false, idn.signature);
    try{
      const s = await gmail.send(t.token, {from:t.email, fromName:person ? `${person} · STRIKD` : idn.displayName, to:x.email, subject, body:m.text, html:m.html, inReplyTo:step > 1 ? x.email1MsgId : ""}, step > 1 ? x.email1Thread : "");
      await c.query("insert into public.email_log (sender, sender_email, uid, vip_id, step, tpl, to_email, message_id, thread_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [key, t.email, u, r.path.split("/")[3], step, tpl.id, x.email, s.messageId, s.threadId]);
      await patchVip(c, r.path, step === 1
        ? {email1At:now, email1Tpl:tpl.id, email1Thread:s.threadId, email1MsgId:s.messageId, email1Sender:key, email1Subject:subject, emailedAt:now, emailedBy:"auto", emailSeq:(x.status || "nuevo") === "nuevo"}
        : {[`email${step}At`]:now, [`email${step}Tpl`]:tpl.id});
      sentToday[key] = (sentToday[key] || 0) + 1; used[tpl.id] = (used[tpl.id] || 0) + 1; out.enviados++;
      if (!firstAt[t.email]) firstAt[t.email] = now;
    }catch(e){
      await c.query("insert into public.email_log (sender, sender_email, uid, vip_id, step, tpl, to_email, status, error) values ($1,$2,$3,$4,$5,$6,$7,'error',$8)",
        [key, t.email, u, r.path.split("/")[3], step, tpl.id, x.email, String(e.message || e).slice(0, 300)]);
      await patchVip(c, r.path, {emailErrorAt:now, emailError:String(e.message || e).slice(0, 200)});
    }
  }
  return out.enviados || out.respuestas || out.dm ? out : null;
}

// ---------- lotes con autorización ----------
const dayKey = t => new Date(t - OFF).toISOString().slice(0, 10);                       // fecha en Cancún
const dayStart = d => Date.parse(d + "T00:00:00Z") + OFF;
function nextBizDay(now){ let t = now + DAY; for (;;){ const w = new Date(t - OFF).getUTCDay(); if (w >= 1 && w <= 4) return dayKey(t); t += DAY; } }
async function ctx(c){
  const cfg = ((await c.query("select data from public.docs where path='config/main'")).rows[0] || {}).data || {};
  const tpls = (await c.query("select id, data from public.docs where parent='emailTpl'")).rows.map(r => ({id:r.id, ...(r.data || {})})).filter(t => t.active !== false && (t.subject || Number(t.step) > 1) && t.body);
  const tokens = {}; (await c.query("select key, email from public.gmail_tokens")).rows.forEach(r => tokens[r.key] = r.email);
  const roles = {}; (await c.query("select path, data from public.docs where parent='roles'")).rows.forEach(r => roles[r.path.split("/")[1]] = r.data || {});
  const names = {}; (await c.query("select id, name, email from public.app_users")).rows.forEach(r => names[r.id] = (r.name || r.email || "").split(" ")[0]);
  const firstAt = {}; (await c.query("select sender_email, min(at) a from public.email_log where status <> 'error' group by sender_email")).rows.forEach(r => firstAt[r.sender_email] = new Date(r.a).getTime());
  const used = {}; (await c.query("select tpl, count(*)::int n from public.email_log group by tpl")).rows.forEach(r => used[r.tpl] = r.n);
  return {cfg, seq:cfg.mailSeq || {}, tpls, tokens, roles, names, firstAt, used};
}
// arma lo que saldría ese día: quién, de qué cuenta, qué approach y el texto ya con su nombre (el Head lo revisa, edita o quita)
async function plan(c, date, opts){
  await gmail.ensure(c);
  const X = await ctx(c), start = dayStart(date), end = start + H_TO * 3600e3, seqOn = X.seq.on === true || !!(opts && opts.preview);
  const seqKeys = SEQ_KEYS.filter(k => X.tokens[k]);
  // lo que ya está autorizado en otro lote sin enviar no se vuelve a meter
  const busy = new Set();
  (await c.query("select data from public.docs where parent='mailBatch' and path <> $1", ["mailBatch/" + date])).rows.forEach(r => { const b = r.data || {};
    if (b.status === "approved" && b.date >= dayKey(Date.now())) (b.items || []).forEach(i => { if (!i.sentAt && !i.skip && !i.error) busy.add(i.path + "#" + i.step); }); });
  const cands = (await c.query(`select path, data from public.docs where path like 'meets/%/vip/%' and coalesce(data->>'status','nuevo') in ('nuevo','contactado')
    and coalesce(data->>'meetId','')='' and coalesce(data->>'email','')<>'' and not (data ? 'emailOptout') and not (data ? 'emailRepliedAt') and not (data ? 'emailBounced')
    and not (data ? 'email3At') and coalesce((data->>'emailSkip')::boolean, false) = false and coalesce((data->>'top')::boolean, false) = false
    and coalesce((data->>'direct')::boolean, false) = false and coalesce((data->>'personal')::boolean, false) = false and coalesce((data->>'noContact')::boolean, false) = false and coalesce((data->>'competitor')::boolean, false) = false and coalesce(data->>'kind','') <> 'ugc'`)).rows;
  // rango de seguidores para los nuevos (approach 1); los seguimientos siguen aunque estén fuera del rango
  const fr = (opts && opts.fol) || X.seq.fol || {}, fMin = Number(fr.min) || 0, fMax = Number(fr.max) || Infinity;
  const inRange = x => { const f = Number(x.followers) || 0; return f >= fMin && f <= fMax; };
  const list = cands.map(r => ({r, step:nextStep(r.data || {}, end, seqOn)})).filter(o => o.step && !busy.has(o.r.path + "#" + o.step) && (o.step > 1 || inRange(o.r.data || {})))
    .sort((a, b) => (b.step - a.step) || ((Number(b.r.data.followers) || 0) - (Number(a.r.data.followers) || 0)));
  const quota = {}, taken = {}, used = {...X.used}, items = [], ids = {};
  const idOf = async k => (ids[k] ||= await gmail.tokenFor(c, k).then(t => t ? gmail.sendAs(t.token, t.email) : {}).catch(() => ({})));
  // si el lote es para hoy, lo que ya salió hoy de cada cuenta cuenta contra su cupo
  const sentToday = {};
  if (date === dayKey(Date.now())) (await c.query("select sender, count(*)::int n from public.email_log where at >= $1 and status <> 'error' group by sender", [new Date(start).toISOString()]).catch(() => ({rows:[]}))).rows.forEach(r => sentToday[r.sender] = r.n);
  const q = k => (quota[k] ??= Math.max(0, quotaFor(X.firstAt[X.tokens[k]], start) - (sentToday[k] || 0)));
  const seen = new Set();
  for (const {r, step} of list){
    const x = r.data || {}, u = r.path.split("/")[1], em = String(x.email).toLowerCase();
    if (seen.has(em)) continue;
    const opts2 = X.tpls.filter(t => Number(t.step) === step); if (!opts2.length) continue;
    let key;
    if (step > 1) key = x.email1Sender && X.tokens[x.email1Sender] ? x.email1Sender : null;
    else if (seqKeys.length) key = seqKeys.filter(k => (taken[k] || 0) < q(k)).sort((a, b) => (taken[a] || 0) - (taken[b] || 0))[0] || null;
    else key = (X.roles[u] || {}).canEmail && X.tokens[u] ? u : (X.tokens.general ? "general" : null);
    if (!key || (taken[key] || 0) >= q(key)) continue;
    taken[key] = (taken[key] || 0) + 1; seen.add(em);
    const tpl = opts2.slice().sort((a, b) => (used[a.id] || 0) - (used[b.id] || 0))[0]; used[tpl.id] = (used[tpl.id] || 0) + 1;
    const person = SEQ_KEYS.includes(key) || key === "general" ? "" : X.names[key] || "";
    const v = {nombre:String(x.prospect || "").split(" ")[0], am:person || (await idOf(key)).displayName || ""};
    items.push({path:r.path, step, key, from:X.tokens[key], to:x.email, name:x.prospect || "", followers:Number(x.followers) || 0, profile:x.profile || "", notes:String(x.notes || "").slice(0, 500),
      tplId:tpl.id, tplName:tpl.name || "", subject:step > 1 && x.email1Subject ? "Re: " + String(x.email1Subject).replace(/^re:\s*/i, "") : fill(tpl.subject, v), body:fill(tpl.body, v)});
  }
  const prev = (await c.query("select data from public.docs where path=$1", ["mailBatch/" + date])).rows[0];
  if (prev && prev.data && prev.data.status === "approved") return prev.data;              // ya autorizado: no se toca
  const b = {date, status:"pending", items, quota, createdAt:Date.now(), seqOn:X.seq.on === true, fol:{min:fMin, max:fMax === Infinity ? null : fMax}};
  await c.query(`insert into public.docs (path, data) values ($1, $2) on conflict (path) do update set data = excluded.data, version = public.docs.version + 1, updated_at = now()`, ["mailBatch/" + date, b]);
  return b;
}
async function notifyHead(c, b){
  const heads = (await c.query("select id from public.app_users where role='head'")).rows.map(r => r.id);
  const d = new Date(dayStart(b.date) + 12 * 3600e3).toLocaleDateString("es-MX", {weekday:"long", day:"numeric", month:"short", timeZone:"America/Cancun"});
  await sendTo(c, heads, {title:`📧 ${b.items.length} emails listos para autorizar`, body:`Salen el ${d} si los autorizas. Revísalos en Outreach.`, url:"/?tab=outreach", tag:"mail-batch"}).catch(() => {});
}
// manda el lote autorizado de hoy, repartido en la jornada (1 por cuenta cada 5 min)
async function sendBatch(c, ctx0){
  const now = ctx0.now, today = dayKey(now);
  // el lote de hoy (si está autorizado) y los que tienen "Enviar ya" (pueden ser de otro día)
  const rows = (await c.query(`select path, data from public.docs where parent='mailBatch' and data->>'status'='approved' and (data->>'date' = $1 or (data->>'sendNow'='true' and data->>'date' >= $1)) order by data->>'date'`, [today])).rows;
  for (const r of rows) await sendOneBatch(c, r.path, r.data, ctx0, r.data.date !== today || r.data.sendNow === true);
}
async function sendOneBatch(c, path, b, {now, seq, tokens, tokenOf, names, out, day0ms, sentToday, firstAt}, now2){
  const date = b.date;
  // con "Enviar ya" sale de corrido (1 por cuenta por vuelta); si no, repartido de 9 a 6
  const frac = now2 ? 1 : Math.min(1, Math.max(0, (now - (day0ms + H_FROM * 3600e3)) / ((H_TO - H_FROM) * 3600e3)));
  const byKey = {}; b.items.forEach(i => { if (!i.skip) (byKey[i.key] ||= []).push(i); });
  let changed = false, tplsNow = null;
  for (const [key, arr] of Object.entries(byKey)){
    const done = arr.filter(i => i.sentAt || i.error || i.void).length, allow = Math.max(1, Math.ceil(arr.length * frac));
    if (done >= allow) continue;
    // nunca más del cupo del día de esa cuenta
    if ((sentToday[key] || 0) >= quotaFor(firstAt[tokens[key]], now)) continue;
    const it = arr.find(i => !i.sentAt && !i.error && !i.void); if (!it) continue;
    changed = true;
    const r = (await c.query("select data from public.docs where path=$1", [it.path])).rows[0], x = r && r.data;
    // si algo cambió desde que se autorizó (contestó, baja, meet, top tier…), ya no sale
    const why = !x ? "ya no está en la lista" : x.emailRepliedAt ? "ya contestó" : x.emailOptout ? "pidió baja" : x.emailBounced ? "rebotó" : x.meetId ? "ya agendó" : x.competitor ? "competidor directo" : x.noContact ? "no enviar nada" : x.personal ? "correo personalizado" : x.top || x.direct ? "lo marcaron 👑/🤝" : x.emailSkip ? "lo marcaron No enviar"
      : x[`email${it.step}At`] ? "ya se le mandó" : it.step > 1 && !x[`email${it.step - 1}At`] ? "falta el approach anterior" : String(x.email || "").toLowerCase() !== String(it.to || "").toLowerCase() ? "cambió su email" : "";
    if (why){ it.void = why; continue; }
    const t = await tokenOf(key); if (!t){ it.error = "la cuenta de envío ya no está conectada"; continue; }
    const idn = await gmail.sendAs(t.token, t.email), u = it.path.split("/")[1];
    // justo antes de mandar se vuelve a escribir con la plantilla actual (salvo que el Head lo haya editado a mano)
    if (!it.edited){ tplsNow ||= (await ctx(c)).tpls; const nx = renderItem(tplsNow, it, x, idn.displayName); if (!nx){ it.void = "sin plantilla activa"; continue; } Object.assign(it, nx); }
    const m = compose(it.body, it.step, seq, it.path, false, idn.signature);
    const person = SEQ_KEYS.includes(key) || key === "general" ? "" : names[key] || "";
    try{
      const s = await gmail.send(t.token, {from:t.email, fromName:person ? `${person} · STRIKD` : idn.displayName, to:x.email, subject:it.subject, body:m.text, html:m.html, inReplyTo:it.step > 1 ? x.email1MsgId : ""}, it.step > 1 ? x.email1Thread : "");
      await c.query("insert into public.email_log (sender, sender_email, uid, vip_id, step, tpl, to_email, message_id, thread_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [key, t.email, u, it.path.split("/")[3], it.step, it.tplId, x.email, s.messageId, s.threadId]);
      await patchVip(c, it.path, it.step === 1
        ? {email1At:now, email1Tpl:it.tplId, email1Thread:s.threadId, email1MsgId:s.messageId, email1Sender:key, email1Subject:it.subject, emailedAt:now, emailedBy:"auto", emailSeq:(x.status || "nuevo") === "nuevo"}
        : {[`email${it.step}At`]:now, [`email${it.step}Tpl`]:it.tplId});
      it.sentAt = now; out.enviados++; sentToday[key] = (sentToday[key] || 0) + 1; if (!firstAt[t.email]) firstAt[t.email] = now;
    }catch(e){
      it.error = String(e.message || e).slice(0, 200);
      await c.query("insert into public.email_log (sender, sender_email, uid, vip_id, step, tpl, to_email, status, error) values ($1,$2,$3,$4,$5,$6,$7,'error',$8)",
        [key, t.email, u, it.path.split("/")[3], it.step, it.tplId, x.email, it.error]);
    }
  }
  if (changed){
    // se reescribe solo la lista de envíos (por si el Head la editó mientras: se respetan sus cambios de items sin enviar)
    const left = b.items.some(i => !i.skip && !i.sentAt && !i.error && !i.void);
    await c.query("update public.docs set data = jsonb_set(jsonb_set(data, '{items}', $2::jsonb), '{sendNow}', $3::jsonb), version = version + 1, updated_at = now() where path = $1", [path, JSON.stringify(b.items), JSON.stringify(!!b.sendNow && left)]);
  }
}
// texto de un email del lote con la plantilla ACTUAL (si cambian la plantilla, los lotes se actualizan; los que el Head editó a mano no)
function renderItem(tpls, it, x, am){
  const same = tpls.filter(t => Number(t.step) === Number(it.step));
  const tpl = same.find(t => t.id === it.tplId) || same[0]; if (!tpl) return null;
  const v = {nombre:String(x.prospect || "").split(" ")[0], am:am || ""};
  return {tplId:tpl.id, tplName:tpl.name || "", subject:it.step > 1 && x.email1Subject ? "Re: " + String(x.email1Subject).replace(/^re:\s*/i, "") : fill(tpl.subject, v), body:fill(tpl.body, v)};
}
// vuelve a escribir los emails sin enviar de los lotes de hoy en adelante con las plantillas actuales
async function refresh(c){
  const X = await ctx(c), today = dayKey(Date.now()), ids = {}, out = {lotes:0, emails:0, sinPlantilla:0};
  const idOf = async k => (ids[k] ||= await gmail.tokenFor(c, k).then(t => t ? gmail.sendAs(t.token, t.email) : {}).catch(() => ({})));
  for (const r of (await c.query("select path, data from public.docs where parent='mailBatch'")).rows){
    const b = r.data || {}; if (!b.date || b.date < today || !Array.isArray(b.items)) continue;
    let ch = false;
    for (const it of b.items){
      if (it.sentAt || it.edited || it.void || it.error) continue;
      const x = ((await c.query("select data from public.docs where path=$1", [it.path])).rows[0] || {}).data; if (!x) continue;
      const nx = renderItem(X.tpls, it, x, (await idOf(it.key)).displayName);
      if (!nx){ if (!it.skip){ it.skip = true; it.skipWhy = "sin plantilla activa"; ch = true; out.sinPlantilla++; } continue; }
      if (it.skipWhy === "sin plantilla activa"){ it.skip = false; it.skipWhy = null; }
      if (nx.subject !== it.subject || nx.body !== it.body || nx.tplId !== it.tplId){ Object.assign(it, nx); ch = true; out.emails++; }
    }
    if (ch){ await c.query("update public.docs set data = jsonb_set(data, '{items}', $2::jsonb), version = version + 1, updated_at = now() where path = $1", [r.path, JSON.stringify(b.items)]); out.lotes++; }
  }
  return out;
}
// email de prueba: lo que saldría, pero a tu correo, con [Prueba] en el asunto y sin contar el clic
async function sendTest(c, {to, key, tplId, date, idx}){
  await gmail.ensure(c);
  const X = await ctx(c);
  let subject, body, step, k = key, name = "Ana";
  if (date){ const b = ((await c.query("select data from public.docs where path=$1", ["mailBatch/" + date])).rows[0] || {}).data; const it = b && b.items && b.items[idx];
    if (!it) throw new Error("No encontré ese email del lote");
    ({subject, body, step} = it); k = k || it.key; name = it.name; }
  else { const tpl = X.tpls.find(t => t.id === tplId) || ((await c.query("select id, data from public.docs where path=$1", ["emailTpl/" + tplId])).rows.map(r => ({id:r.id, ...r.data}))[0]);
    if (!tpl) throw new Error("No encontré la plantilla");
    step = Number(tpl.step) || 1; const v = {nombre:"Ana", am:""};
    subject = step > 1 ? "Re: (asunto del approach 1)" : fill(tpl.subject, v); body = fill(tpl.body, v); }
  k = k && X.tokens[k] ? k : SEQ_KEYS.find(x => X.tokens[x]) || (X.tokens.general ? "general" : null);
  if (!k) throw new Error("Conecta al menos una cuenta de envío");
  const t = await gmail.tokenFor(c, k); if (!t) throw new Error("La cuenta de envío no responde; vuelve a conectarla");
  const idn = await gmail.sendAs(t.token, t.email), m = compose(body, step, X.seq, "meets/test/vip/test", true, idn.signature);
  await gmail.send(t.token, {from:t.email, fromName:idn.displayName, to, subject:"[Prueba] " + subject, body:m.text, html:m.html});
  return {ok:true, from:t.email, to, name};
}
module.exports = {run, inWindow, fill, FOOTER, compose, quotaFor, nextStep, SEQ_KEYS, plan, sendTest, nextBizDay, dayKey, notifyHead, refresh};
