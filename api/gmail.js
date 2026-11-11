// Emails automáticos: estado de las cuentas de Gmail conectadas, envíos y desconectar.
// GET  → {general, me, people (Head/Manager), today, tpl (por plantilla: enviados / contestados)}
// POST {inbox:{key?}} · {thread:{key,id}} · {reply:{key,threadId,body}} buzón (Head y Manager)
// POST {disconnect:"general"|"me"|"seqN"} · {plan:{date}} prepara el lote de un día · {test:{to, tplId|date+idx, key}} manda una prueba
const { withPg, userFromReq } = require("../lib/google");
const gmail = require("../lib/gmail");
module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  const me = await userFromReq(req);
  if (!me) return res.status(401).json({error:"Sesión no válida"});
  const lead = me.role === "head" || me.role === "manager";
  try{
    const out = await withPg(async c => {
      await gmail.ensure(c);
      if (req.method === "POST"){
        const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
        // buzón de las cuentas de envío (Head y Manager): lista, hilo y responder
        if (b.inbox || b.thread || b.reply){
          if (!lead) return {status:403, error:"Solo Head y Manager"};
          const { SEQ_KEYS } = require("../lib/emailauto");
          const keys = (await c.query("select key, email from public.gmail_tokens")).rows.filter(r => SEQ_KEYS.includes(r.key) || r.key === "general");
          if (b.inbox){
            const vips = {}; const byTh = {};
            (await c.query("select path, data->>'email' em, data->>'prospect' nm, data->>'profile' pr, coalesce(data->>'emailRepliedAt','') rep, data->>'email1Thread' th, data->'mailLog' ml from public.docs where path like 'meets/%/vip/%' and (coalesce(data->>'email','')<>'' or data ? 'email1Thread')")).rows.forEach(r => {
              const v = {path:r.path, name:r.nm, profile:r.pr, replied:!!r.rep}; if (r.em) vips[String(r.em).toLowerCase()] = v; if (r.th) byTh[r.th] = v; (Array.isArray(r.ml) ? r.ml : []).forEach(m => { if (m && m.threadId) byTh[m.threadId] = v; }); });
            const res = await Promise.all(keys.filter(k => !b.inbox.key || k.key === b.inbox.key).map(async k => { try{ const t = await gmail.tokenFor(c, k.key); if (!t) return {key:k.key, email:k.email, error:"sin conexión"};
              return {key:k.key, email:k.email, items:(await gmail.inbox(t.token, 25)).map(m => { const em = (String(m.from).match(/<([^>]+)>/) || [, m.from])[1].trim().toLowerCase(); return {...m, key:k.key, account:k.email, fromEmail:em, vip:byTh[m.threadId] || vips[em] || null}; })}; }
              catch(e){ return {key:k.key, email:k.email, error:String(e.message || e)}; } }));
            return {ok:true, accounts:res.map(r => ({key:r.key, email:r.email, error:r.error || null, n:(r.items || []).length})), items:res.flatMap(r => r.items || []).sort((a, z) => z.at - a.at)};
          }
          const k = keys.find(x => x.key === (b.thread || b.reply).key); if (!k) return {status:400, error:"Cuenta no encontrada"};
          const t = await gmail.tokenFor(c, k.key); if (!t) return {status:400, error:"La cuenta no responde; vuelve a conectarla"};
          if (b.thread) return {ok:true, messages:await gmail.thread(t.token, String(b.thread.id))};
          // responder en el mismo hilo, con la firma de Gmail de esa cuenta
          const msgs = await gmail.thread(t.token, String(b.reply.threadId)), last = [...msgs].reverse().find(m => !m.mine) || msgs[msgs.length - 1];
          if (!last) return {status:400, error:"Hilo vacío"};
          const text = String(b.reply.body || "").trim(); if (!text) return {status:400, error:"Escribe la respuesta"};
          const ea = require("../lib/emailauto"), idn = await gmail.sendAs(t.token, t.email), m = ea.compose(text, 2, {}, "", true, idn.signature);
          const to = (String(last.from).match(/<([^>]+)>/) || [, last.from])[1].trim(), subj = /^re:/i.test(last.subject) ? last.subject : "Re: " + last.subject;
          const s2 = await gmail.send(t.token, {from:t.email, fromName:idn.displayName, to, subject:subj, body:m.text, html:m.html, inReplyTo:last.msgId}, String(b.reply.threadId));
          await c.query("insert into public.email_log (sender, sender_email, uid, step, tpl, to_email, message_id, thread_id, status) values ($1,$2,$3,0,'manual',$4,$5,$6,'manual')", [k.key, t.email, me.id, to, s2.messageId, s2.threadId]).catch(() => {});
          return {ok:true, to};
        }
        // correo a mano a un influencer desde Outreach (Head y Manager). Cuenta: la que se elija o rota (la de menos envíos hoy con cupo)
        if (b.compose){
          if (!lead) return {status:403, error:"Solo Head y Manager"};
          const ea = require("../lib/emailauto"), q = b.compose, path = String(q.path || "");
          if (!/^meets\/[^/]+\/vip\/[^/]+$/.test(path)) return {status:400, error:"Perfil no válido"};
          const x = ((await c.query("select data from public.docs where path=$1", [path])).rows[0] || {}).data;
          if (!x) return {status:404, error:"Ese perfil ya no está en la lista"};
          if (!x.email) return {status:400, error:"Ese perfil no tiene correo"};
          if (x.emailOptout) return {status:400, error:"Pidió no recibir correos («baja»)"};
          const subject = String(q.subject || "").trim(), text = String(q.body || "").trim();
          if (!subject || !text) return {status:400, error:"Pon asunto y mensaje"};
          const toks = (await c.query("select key, email from public.gmail_tokens")).rows.filter(r => ea.SEQ_KEYS.includes(r.key));
          if (!toks.length) return {status:400, error:"Conecta al menos una cuenta de envío"};
          const day0 = new Date(Date.parse(new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10) + "T05:00:00Z")).toISOString();
          // los correos a mano no gastan el cupo automático; tienen su propio tope por cuenta al día (config/main.mailSeq.manualMax, 40 por defecto)
          const cfgS = (((await c.query("select data from public.docs where path='config/main'")).rows[0] || {}).data || {}).mailSeq || {}, MAN = Number(cfgS.manualMax) || 40;
          const st = {}; (await c.query("select sender, count(*)::int n from public.email_log where at >= $1 and status <> 'error' and (status = 'manual' or tpl = 'manual') group by sender", [day0])).rows.forEach(r => st[r.sender] = r.n);
          const fa = {}; (await c.query("select sender_email, min(at) a from public.email_log where status <> 'error' group by sender_email")).rows.forEach(r => fa[r.sender_email] = new Date(r.a).getTime());
          const free = k => (st[k.key] || 0) < MAN;
          const k = q.key ? toks.find(t => t.key === q.key) : toks.filter(free).sort((a, z) => (st[a.key] || 0) - (st[z.key] || 0))[0];
          if (!k) return {status:400, error:q.key ? "Esa cuenta no está conectada" : `Todas las cuentas llegaron a ${MAN} correos a mano hoy`};
          if (q.key && !free(k)) return {status:400, error:`Esa cuenta ya mandó ${MAN} correos a mano hoy; elige otra o deja "Rotar"`};
          const t = await gmail.tokenFor(c, k.key); if (!t) return {status:400, error:"La cuenta no responde; vuelve a conectarla"};
          const idn = await gmail.sendAs(t.token, t.email), m = ea.compose(text, 0, (((await c.query("select data from public.docs where path='config/main'")).rows[0] || {}).data || {}).mailSeq || {}, path, true, idn.signature);
          const s2 = await gmail.send(t.token, {from:t.email, fromName:idn.displayName, to:x.email, subject, body:m.text, html:m.html});
          const now = Date.now(), [, u, , vid] = path.split("/");
          // si todavía no tenía secuencia y se pidió seguir con ella, este correo cuenta como su approach 1 (los seguimientos salen solos)
          const asSeq = q.seq !== false && !x.email1At;
          await c.query("insert into public.email_log (sender, sender_email, uid, vip_id, step, tpl, to_email, message_id, thread_id, status) values ($1,$2,$3,$4,$5,'manual',$6,$7,$8,'sent')", [k.key, t.email, u, vid, asSeq ? 1 : 0, x.email, s2.messageId, s2.threadId]);
          const log = (Array.isArray(x.mailLog) ? x.mailLog : []).concat([{at:now, by:me.id, from:t.email, subject, threadId:s2.threadId}]).slice(-30);
          const patch = {mailLog:log, ...(asSeq ? {email1At:now, email1Tpl:"manual", email1Thread:s2.threadId, email1MsgId:s2.messageId, email1Sender:k.key, email1Subject:subject, emailedAt:now, emailedBy:me.id, emailSeq:(x.status || "nuevo") === "nuevo"} : {})};
          await c.query("update public.docs set data = data || $2::jsonb, version = version + 1, updated_at = now() where path = $1", [path, JSON.stringify(patch)]);
          return {ok:true, from:t.email, to:x.email, asSeq};
        }
        // lotes con autorización y emails de prueba (solo el Head)
        if (b.fixReplies){ if (!lead) return {status:403, error:"Solo Head y Manager"}; const ea = require("../lib/emailauto"); const f = {}, sr = await ea.scanReplies(c).catch(() => ({})); /* la corrección de rebotes ya corrió una vez (cron); aquí solo se buscan respuestas nuevas */ return {ok:true, ...f, nuevas:sr.respuestas || 0, rebotesNuevos:sr.rebotes || 0}; }
        if (b.plan || b.test || b.refresh){
          if (me.role !== "head") return {status:403, error:"Solo el Head"};
          const ea = require("../lib/emailauto");
          if (b.refresh) return {ok:true, ...(await ea.refresh(c))};
          if (b.test) return await ea.sendTest(c, {to:String(b.test.to || me.email || "").trim(), key:b.test.key, tplId:b.test.tplId, date:b.test.date, idx:Number(b.test.idx)});
          const date = b.plan.date === "today" ? ea.dayKey(Date.now()) : /^\d{4}-\d{2}-\d{2}$/.test(b.plan.date || "") ? b.plan.date : ea.nextBizDay(Date.now());
          const fol = b.plan.fol && typeof b.plan.fol === "object" ? {min:Number(b.plan.fol.min) || 0, max:b.plan.fol.max == null || b.plan.fol.max === "" ? null : Number(b.plan.fol.max)} : null;
          const pid = /^\d{4}-\d{2}-\d{2}(-\d+)?$/.test(b.plan.id || "") ? b.plan.id : "";
          const r = await ea.plan(c, date, {preview:true, ...(pid ? {id:pid} : {}), ...(fol ? {fol} : {})});
          return {ok:true, date, id:r.id, n:(r.items || []).length, status:r.status};
        }
        const key = b.disconnect === "general" || /^seq[1-5]$/.test(b.disconnect || "") ? (me.role === "head" ? b.disconnect : null) : b.disconnect === "me" ? me.id : null;
        if (!key) return {status:403, error:"Sin permiso"};
        await c.query("delete from public.gmail_tokens where key=$1", [key]); return {ok:true};
      }
      const rows = (await c.query("select key, email from public.gmail_tokens")).rows;
      const general = rows.find(r => r.key === "general") || null, mine = rows.find(r => r.key === me.id) || null;
      const day0 = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10) + "T05:00:00Z";
      const today = (await c.query("select sender, count(*)::int n from public.email_log where at >= $1 and status='sent' and coalesce(tpl,'') <> 'manual' group by sender", [day0])).rows;
      const todayMan = {}; (await c.query("select sender, count(*)::int n from public.email_log where at >= $1 and status <> 'error' and (status = 'manual' or tpl = 'manual') group by sender", [day0])).rows.forEach(r => todayMan[r.sender] = r.n);
      const base = {general:general ? {email:general.email} : null, me:mine ? {email:mine.email} : null, today:Object.fromEntries(today.map(r => [r.sender, r.n])), limit:20};
      if (!lead) return base;
      const tpl = (await c.query(`select tpl, step, count(*)::int sent, count(*) filter (where status in ('replied','optout'))::int replied from public.email_log
        where status <> 'error' group by tpl, step`)).rows;
      // secuencia: cuentas de envío con su cupo de calentamiento, y números por approach (enviados, abrieron el video, contestaron)
      const { quotaFor, SEQ_KEYS } = require("../lib/emailauto");
      const first = {}; (await c.query("select sender_email, min(at) a from public.email_log where status <> 'error' group by sender_email")).rows.forEach(r => first[r.sender_email] = new Date(r.a).getTime());
      const tot = {}; (await c.query("select sender, count(*)::int n from public.email_log where status <> 'error' group by sender")).rows.forEach(r => tot[r.sender] = r.n);
      const seq = SEQ_KEYS.map(k => { const r = rows.find(x => x.key === k); return r ? {key:k, email:r.email, today:base.today[k] || 0, manual:todayMan[k] || 0, quota:quotaFor(first[r.email], Date.now()), total:tot[k] || 0, since:first[r.email] || null} : {key:k}; });
      await c.query("create table if not exists public.email_clicks (id bigserial primary key, uid text, vip_id text, step int, at timestamptz default now())").catch(() => {});
      const clk = {}; (await c.query("select step, count(distinct vip_id)::int n from public.email_clicks group by step")).rows.forEach(r => clk[r.step] = r.n);
      const steps = (await c.query(`select step, count(*)::int sent, count(*) filter (where status in ('replied','optout'))::int replied
        from public.email_log where status <> 'error' group by step`)).rows.map(r => ({...r, clicked:clk[r.step] || 0}));
      const q = (await c.query(`select count(*) filter (where data ? 'email1At' and coalesce(data->>'emailRepliedAt','') = '' and not (data ? 'dmDueAt') and coalesce((data->>'emailOptout')::boolean,false) = false)::int active,
        count(*) filter (where data ? 'dmDueAt' and coalesce(data->>'status','nuevo')='nuevo')::int dm,
        count(*) filter (where coalesce(data->>'email','')<>'' and not (data ? 'email1At') and coalesce(data->>'status','nuevo') in ('nuevo','contactado') and coalesce(data->>'meetId','')=''
          and coalesce((data->>'top')::boolean,false)=false and coalesce((data->>'direct')::boolean,false)=false and coalesce((data->>'personal')::boolean,false)=false and coalesce((data->>'noContact')::boolean,false)=false and coalesce((data->>'competitor')::boolean,false)=false and coalesce((data->>'emailSkip')::boolean,false)=false and coalesce(data->>'kind','')<>'ugc' and coalesce((data->>'emailOptout')::boolean,false) = false)::int waiting
        from public.docs where path like 'meets/%/vip/%'`)).rows[0] || {};
      return {...base, people:rows.filter(r => r.key !== "general" && !SEQ_KEYS.includes(r.key)).map(r => ({uid:r.key, email:r.email})), tpl, seq, steps, queue:q};
    });
    res.status(out.status || 200).json(out);
  }catch(err){ res.status(500).json({error:String(err.message || err)}); }
};
