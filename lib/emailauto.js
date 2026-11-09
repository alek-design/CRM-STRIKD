// Secuencia de emails a influencers de la Lista de Mich (Alek, 9 nov 2026):
//  Approach 1 (día 0) micropitch con video → Approach 2 (día 3, mismo hilo) → Approach 3 (día 7, mismo hilo) → DM de Mich (día 10).
// A quién: perfiles con email que no son 👑 Top tier ni 🤝 Contacto directo, ni UGC, ni marcados "No enviar".
//  - Pendientes (Mich no les ha escrito): el approach 1 sale en cuanto haya cupo.
//  - Ya contactados por DM: el approach 1 sale 10 días después del DM (como antes) y no llevan DM al final.
// Los pendientes entran solo con la secuencia encendida (config/main.mailSeq.on, en Ajustes → Emails automáticos).
// Se detiene si contestan, piden «baja», rebota, agendan meet o los marcan Top tier / Contacto directo.
// Sale de las 3 cuentas de envío (gmail_tokens key seq1..seq3); cada perfil se queda con la misma cuenta toda la secuencia.
// Si no hay cuentas de envío, del Gmail del AM autorizado o del correo general (como antes).
// Cupo por cuenta al día (incluye seguimientos; primero salen los seguimientos): calentamiento 5 → 10 → 15 → 20 por semana desde su primer envío.
// De lunes a viernes de 9 am a 6 pm (Cancún), repartidos en el día (máx. 1 por cuenta cada 5 min).
const gmail = require("./gmail");
const { sendTo } = require("./push");
const { sign } = require("./google");
const OFF = 5 * 3600e3, DAY = 864e5, LIMIT = 20, H_FROM = 9, H_TO = 18;
const WAIT = {2:3 * DAY, 3:4 * DAY, dm:3 * DAY, dmFirst:10 * DAY};
const FOOTER = "\n\n—\nSi prefieres que no te volvamos a escribir, responde «baja» y listo.";
const ORIGIN = process.env.PUBLIC_ORIGIN || "https://growth.strikd.ai";
const SEQ_KEYS = ["seq1", "seq2", "seq3"];

function inWindow(now){
  const l = new Date(now - OFF), d = l.getUTCDay(), h = l.getUTCHours();
  return d >= 1 && d <= 5 && h >= H_FROM && h < H_TO;
}
const fill = (t, v) => String(t || "").replace(/\{nombre\}/g, v.nombre || "").replace(/\{am\}/g, v.am || "").replace(/\s+([!,.?])/g, "$1").trim();
async function patchVip(c, path, patch){
  await c.query("update public.docs set data = data || $2::jsonb, version = version + 1, updated_at = now() where path = $1", [path, JSON.stringify(patch)]);
}
// cupo de calentamiento según cuántos días lleva mandando esa cuenta
function quotaFor(firstAt, now){
  if (!firstAt) return 5;
  const d = (now - firstAt) / DAY;
  return d < 7 ? 5 : d < 14 ? 10 : d < 21 ? 15 : LIMIT;
}
// link con firma para contar quién abre el video (api/v)
const trackUrl = (path, step) => { const p = path.split("/"), t = `${p[1]}.${p[3]}.${step}`; return `${ORIGIN}/api/v?t=${encodeURIComponent(t + "." + sign(t).slice(0, 16))}`; };
const escH = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const linkify = s => s.replace(/https?:\/\/[^\s<]+/g, u => `<a href="${u}">${u}</a>`);
function thumbOf(seq){
  if (seq.thumb) return /^https?:/i.test(seq.thumb) ? seq.thumb : `${ORIGIN}/_blob/${seq.thumb}`;
  const yt = String(seq.video || "").match(/(?:youtu\.be\/|v=|shorts\/|embed\/)([\w-]{11})/);
  return yt ? `https://img.youtube.com/vi/${yt[1]}/hqdefault.jpg` : "";
}
// arma texto y HTML; {video} marca dónde va el video (en el approach 1 va al final si no lo pusieron)
function compose(body, step, seq, path){
  const has = /\{video\}/.test(body), want = !!seq.video && (has || step === 1);
  const url = want ? trackUrl(path, step) : "", label = seq.videoLabel || "▶ Ver video";
  const parts = String(body).split("{video}"), thumb = thumbOf(seq);
  const vText = url ? `\n\n${label}: ${url}\n\n` : "";
  const vHtml = url ? `<p style="margin:16px 0">${thumb ? `<a href="${url}"><img src="${escH(thumb)}" alt="${escH(label)}" width="480" style="display:block;max-width:100%;border-radius:10px;border:0"></a>` : ""}<a href="${url}" style="display:inline-block;margin-top:8px;font-weight:600">${escH(label)}</a></p>` : "";
  const segs = want && !has ? [parts.join(""), ""] : parts;
  const text = segs.map(s => s.trim()).join(vText).replace(/\n{3,}/g, "\n\n").trim() + FOOTER;
  const htmlBody = segs.map(s => s.trim() ? `<p style="margin:0 0 12px">${linkify(escH(s.trim())).replace(/\n\n+/g, '</p><p style="margin:0 0 12px">').replace(/\n/g, "<br>")}</p>` : "").join(vHtml);
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111">${htmlBody}<p style="margin:18px 0 0;font-size:12px;color:#777">Si prefieres que no te volvamos a escribir, responde «baja» y listo.</p></div>`;
  return {text, html:url ? html : ""};
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
  if (!(opts && opts.force) && (!inWindow(now) || new Date(now).getUTCMinutes() % 5 !== 0)) return null;
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
  const watching = (await c.query(`select path, data from public.docs where path like 'meets/%/vip/%' and data ? 'email1Thread'
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
  const dmRows = (await c.query(`select path, data from public.docs where path like 'meets/%/vip/%' and data ? 'email3At' and not (data ? 'dmDueAt')
    and not (data ? 'emailRepliedAt') and coalesce(data->>'status','nuevo')='nuevo' and coalesce(data->>'meetId','')='' and (data->>'email3At')::bigint < $1`, [now - WAIT.dm])).rows;
  const dmBy = {};
  for (const r of dmRows){ await patchVip(c, r.path, {dmDueAt:now}); const u = r.path.split("/")[1]; dmBy[u] = (dmBy[u] || 0) + 1; out.dm++; }
  for (const [u, n] of Object.entries(dmBy))
    await sendTo(c, [u], {title:`💬 ${n} influencer${n === 1 ? "" : "s"} para DM`, body:"No contestaron los 3 emails. Ya salen hasta arriba en tus Pendientes.", url:"/?tab=mich", tag:"dm-due"}).catch(() => {});

  // 3) mandar los que tocan: primero seguimientos (3, 2), luego nuevos por más seguidores
  if (!tpls.length) return out.enviados || out.respuestas || out.dm ? out : null;
  const cands = (await c.query(`select path, data from public.docs where path like 'meets/%/vip/%' and coalesce(data->>'status','nuevo') in ('nuevo','contactado')
    and coalesce(data->>'meetId','')='' and coalesce(data->>'email','')<>'' and not (data ? 'emailOptout') and not (data ? 'emailRepliedAt') and not (data ? 'emailBounced')
    and not (data ? 'email3At') and coalesce((data->>'emailSkip')::boolean, false) = false and coalesce((data->>'top')::boolean, false) = false
    and coalesce((data->>'direct')::boolean, false) = false and coalesce(data->>'kind','') <> 'ugc'`)).rows;
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
    const am = person || seq.senderName || "Equipo STRIKD", v = {nombre:String(x.prospect || "").split(" ")[0], am};
    const subject = step > 1 && x.email1Subject ? "Re: " + String(x.email1Subject).replace(/^re:\s*/i, "") : fill(tpl.subject, v);
    const m = compose(fill(tpl.body, v), step, seq, r.path);
    try{
      const s = await gmail.send(t.token, {from:t.email, fromName:person ? `${person} · STRIKD` : (seq.senderName ? `${seq.senderName} · STRIKD` : "STRIKD"), to:x.email, subject, body:m.text, html:m.html, inReplyTo:step > 1 ? x.email1MsgId : ""}, step > 1 ? x.email1Thread : "");
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
module.exports = {run, inWindow, fill, FOOTER, compose, quotaFor, nextStep, SEQ_KEYS};
