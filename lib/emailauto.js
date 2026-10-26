// Emails automáticos a influencers de la Lista de Mich que no cerraron:
//  1) a los 10 días de que Mich lo contactó sin meet  → plantilla del paso 1
//  2) 7 días después, si no contestó                  → plantilla del paso 2 (en el mismo hilo)
// Sale del Gmail del AM que lo propuso si está autorizado y conectado; si no, del correo general.
// Máximo 20 por cuenta al día, de lunes a viernes de 9 am a 6 pm (Cancún). Si contestan, se detiene y se avisa al AM;
// si contestan "baja", ya no se le vuelve a escribir.
const gmail = require("./gmail");
const { sendTo } = require("./push");
const OFF = 5 * 3600e3, DAY = 864e5, LIMIT = 20;
const FOOTER = "\n\n—\nSi prefieres que no te volvamos a escribir, responde «baja» y listo.";

function inWindow(now){
  const l = new Date(now - OFF), d = l.getUTCDay(), h = l.getUTCHours();
  return d >= 1 && d <= 5 && h >= 9 && h < 18;
}
const fill = (t, v) => String(t || "").replace(/\{nombre\}/g, v.nombre || "").replace(/\{am\}/g, v.am || "").replace(/\s+([!,.?])/g, "$1").trim();
async function patchVip(c, path, patch){
  await c.query("update public.docs set data = data || $2::jsonb, version = version + 1, updated_at = now() where path = $1", [path, JSON.stringify(patch)]);
}

async function run(c, opts){
  const now = Date.now();
  if (!(opts && opts.force) && (!inWindow(now) || new Date(now).getUTCMinutes() % 5 !== 0)) return null;
  await gmail.ensure(c);
  const tpls = (await c.query("select id, data from public.docs where parent='emailTpl'")).rows.map(r => ({id:r.id, ...(r.data || {})})).filter(t => t.active !== false && t.subject && t.body);
  const tokens = {}; (await c.query("select key, email from public.gmail_tokens")).rows.forEach(r => tokens[r.key] = r.email);
  const out = {enviados:0, respuestas:0};
  if (!Object.keys(tokens).length) return null;
  const roles = {}; (await c.query("select path, data from public.docs where parent='roles'")).rows.forEach(r => roles[r.path.split("/")[1]] = r.data || {});
  const names = {}; (await c.query("select id, name, email from public.app_users")).rows.forEach(r => names[r.id] = (r.name || r.email || "").split(" ")[0]);
  const day0 = new Date(Date.parse(new Date(now - OFF).toISOString().slice(0, 10) + "T00:00:00Z") + OFF).toISOString();
  const sentToday = {}; (await c.query("select sender, count(*)::int n from public.email_log where at >= $1 and status <> 'error' group by sender", [day0])).rows.forEach(r => sentToday[r.sender] = r.n);
  const used = {}; (await c.query("select tpl, count(*)::int n from public.email_log group by tpl")).rows.forEach(r => used[r.tpl] = r.n);
  const tok = {}; const tokenOf = async k => (tok[k] ||= await gmail.tokenFor(c, k));

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
          await sendTo(c, [u], {title:`✉️ ${x.prospect || "Un influencer"} contestó tu email`, body:String(rep.snippet || "Te contestó").slice(0, 160), url:"/?tab=agenda", tag:"email-" + r.path}).catch(() => {});
        }
        out.respuestas++;
      } else await patchVip(c, r.path, {emailCheckedAt:now});
    }catch(e){ await patchVip(c, r.path, {emailCheckedAt:now}); }
  }

  // 2) mandar los que tocan
  if (!tpls.length) return out.respuestas ? out : null;
  const cands = (await c.query(`select path, data from public.docs where path like 'meets/%/vip/%' and data->>'status'='contactado'
    and coalesce(data->>'meetId','')='' and coalesce(data->>'email','')<>'' and not (data ? 'emailOptout') and not (data ? 'emailRepliedAt') and not (data ? 'emailBounced')
    and coalesce((data->>'emailSkip')::boolean, false) = false and coalesce((data->>'top')::boolean, false) = false and coalesce((data->>'direct')::boolean, false) = false and coalesce(data->>'kind','') <> 'ugc'`)).rows; // UGC: sin emails automáticos (las plantillas son para influencers) // Mich puede marcar "No enviar" por estrategia
  cands.sort((a, b) => (Number(a.data.contactedAt) || 0) - (Number(b.data.contactedAt) || 0));
  const runSent = {};
  for (const r of cands){
    const x = r.data || {}, u = r.path.split("/")[1], cAt = Number(x.contactedAt || x.statusAt) || 0;
    const step = !x.email1At ? (cAt && now >= cAt + 10 * DAY ? 1 : 0) : (!x.email2At && now >= Number(x.email1At) + 7 * DAY ? 2 : 0);
    if (!step || (Number(x.emailErrorAt) || 0) > now - DAY) continue; // si falló, se reintenta al día siguiente
    const opts2 = tpls.filter(t => Number(t.step) === step); if (!opts2.length) continue;
    // de quién sale: el mismo del primer email; si no, el AM autorizado y conectado; si no, el general
    const key = step === 2 && x.email1Sender && tokens[x.email1Sender] ? x.email1Sender : ((roles[u] || {}).canEmail && tokens[u] ? u : (tokens.general ? "general" : null));
    if (!key || (sentToday[key] || 0) >= LIMIT || runSent[key]) continue; // 1 por cuenta cada 5 min: que no salgan en ráfaga
    runSent[key] = 1;
    const t = await tokenOf(key); if (!t) continue;
    const tpl = opts2.slice().sort((a, b) => (used[a.id] || 0) - (used[b.id] || 0))[0];
    const am = key === "general" ? "" : names[key] || "", v = {nombre:String(x.prospect || "").split(" ")[0], am:am || "Equipo STRIKD"};
    const subject = step === 2 && x.email1Subject ? "Re: " + String(x.email1Subject).replace(/^re:\s*/i, "") : fill(tpl.subject, v);
    const body = fill(tpl.body, v) + FOOTER;
    try{
      const s = await gmail.send(t.token, {from:t.email, fromName:am ? `${am} · STRIKD` : "STRIKD", to:x.email, subject, body, inReplyTo:step === 2 ? x.email1MsgId : ""}, step === 2 ? x.email1Thread : "");
      await c.query("insert into public.email_log (sender, sender_email, uid, vip_id, step, tpl, to_email, message_id, thread_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [key, t.email, u, r.path.split("/")[3], step, tpl.id, x.email, s.messageId, s.threadId]);
      await patchVip(c, r.path, step === 1
        ? {email1At:now, email1Tpl:tpl.id, email1Thread:s.threadId, email1MsgId:s.messageId, email1Sender:key, email1Subject:subject, emailedAt:now, emailedBy:"auto"}
        : {email2At:now, email2Tpl:tpl.id});
      sentToday[key] = (sentToday[key] || 0) + 1; used[tpl.id] = (used[tpl.id] || 0) + 1; out.enviados++;
    }catch(e){
      await c.query("insert into public.email_log (sender, sender_email, uid, vip_id, step, tpl, to_email, status, error) values ($1,$2,$3,$4,$5,$6,$7,'error',$8)",
        [key, t.email, u, r.path.split("/")[3], step, tpl.id, x.email, String(e.message || e).slice(0, 300)]);
      await patchVip(c, r.path, {emailErrorAt:now, emailError:String(e.message || e).slice(0, 200)});
    }
  }
  return out.enviados || out.respuestas ? out : null;
}
module.exports = {run, inWindow, fill, FOOTER};
