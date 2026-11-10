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
            const vips = {}; (await c.query("select path, data->>'email' em, data->>'prospect' nm, data->>'profile' pr from public.docs where path like 'meets/%/vip/%' and coalesce(data->>'email','')<>''")).rows.forEach(r => vips[String(r.em).toLowerCase()] = {path:r.path, name:r.nm, profile:r.pr});
            const res = await Promise.all(keys.filter(k => !b.inbox.key || k.key === b.inbox.key).map(async k => { try{ const t = await gmail.tokenFor(c, k.key); if (!t) return {key:k.key, email:k.email, error:"sin conexión"};
              return {key:k.key, email:k.email, items:(await gmail.inbox(t.token, 25)).map(m => { const em = (String(m.from).match(/<([^>]+)>/) || [, m.from])[1].trim().toLowerCase(); return {...m, key:k.key, account:k.email, fromEmail:em, vip:vips[em] || null}; })}; }
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
        // lotes con autorización y emails de prueba (solo el Head)
        if (b.plan || b.test || b.refresh){
          if (me.role !== "head") return {status:403, error:"Solo el Head"};
          const ea = require("../lib/emailauto");
          if (b.refresh) return {ok:true, ...(await ea.refresh(c))};
          if (b.test) return await ea.sendTest(c, {to:String(b.test.to || me.email || "").trim(), key:b.test.key, tplId:b.test.tplId, date:b.test.date, idx:Number(b.test.idx)});
          const date = b.plan.date === "today" ? ea.dayKey(Date.now()) : /^\d{4}-\d{2}-\d{2}$/.test(b.plan.date || "") ? b.plan.date : ea.nextBizDay(Date.now());
          const fol = b.plan.fol && typeof b.plan.fol === "object" ? {min:Number(b.plan.fol.min) || 0, max:b.plan.fol.max == null || b.plan.fol.max === "" ? null : Number(b.plan.fol.max)} : null;
          const r = await ea.plan(c, date, {preview:true, ...(fol ? {fol} : {})});
          return {ok:true, date, n:(r.items || []).length, status:r.status};
        }
        const key = b.disconnect === "general" || /^seq[1-5]$/.test(b.disconnect || "") ? (me.role === "head" ? b.disconnect : null) : b.disconnect === "me" ? me.id : null;
        if (!key) return {status:403, error:"Sin permiso"};
        await c.query("delete from public.gmail_tokens where key=$1", [key]); return {ok:true};
      }
      const rows = (await c.query("select key, email from public.gmail_tokens")).rows;
      const general = rows.find(r => r.key === "general") || null, mine = rows.find(r => r.key === me.id) || null;
      const day0 = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10) + "T05:00:00Z";
      const today = (await c.query("select sender, count(*)::int n from public.email_log where at >= $1 and status='sent' group by sender", [day0])).rows;
      const base = {general:general ? {email:general.email} : null, me:mine ? {email:mine.email} : null, today:Object.fromEntries(today.map(r => [r.sender, r.n])), limit:20};
      if (!lead) return base;
      const tpl = (await c.query(`select tpl, step, count(*)::int sent, count(*) filter (where status in ('replied','optout'))::int replied from public.email_log
        where status <> 'error' group by tpl, step`)).rows;
      // secuencia: cuentas de envío con su cupo de calentamiento, y números por approach (enviados, abrieron el video, contestaron)
      const { quotaFor, SEQ_KEYS } = require("../lib/emailauto");
      const first = {}; (await c.query("select sender_email, min(at) a from public.email_log where status <> 'error' group by sender_email")).rows.forEach(r => first[r.sender_email] = new Date(r.a).getTime());
      const tot = {}; (await c.query("select sender, count(*)::int n from public.email_log where status <> 'error' group by sender")).rows.forEach(r => tot[r.sender] = r.n);
      const seq = SEQ_KEYS.map(k => { const r = rows.find(x => x.key === k); return r ? {key:k, email:r.email, today:base.today[k] || 0, quota:quotaFor(first[r.email], Date.now()), total:tot[k] || 0, since:first[r.email] || null} : {key:k}; });
      await c.query("create table if not exists public.email_clicks (id bigserial primary key, uid text, vip_id text, step int, at timestamptz default now())").catch(() => {});
      const clk = {}; (await c.query("select step, count(distinct vip_id)::int n from public.email_clicks group by step")).rows.forEach(r => clk[r.step] = r.n);
      const steps = (await c.query(`select step, count(*)::int sent, count(*) filter (where status in ('replied','optout'))::int replied
        from public.email_log where status <> 'error' group by step`)).rows.map(r => ({...r, clicked:clk[r.step] || 0}));
      const q = (await c.query(`select count(*) filter (where data ? 'email1At' and not (data ? 'emailRepliedAt') and not (data ? 'dmDueAt') and not (data ? 'emailOptout'))::int active,
        count(*) filter (where data ? 'dmDueAt' and coalesce(data->>'status','nuevo')='nuevo')::int dm,
        count(*) filter (where coalesce(data->>'email','')<>'' and not (data ? 'email1At') and coalesce(data->>'status','nuevo') in ('nuevo','contactado') and coalesce(data->>'meetId','')=''
          and coalesce((data->>'top')::boolean,false)=false and coalesce((data->>'direct')::boolean,false)=false and coalesce((data->>'personal')::boolean,false)=false and coalesce((data->>'noContact')::boolean,false)=false and coalesce((data->>'competitor')::boolean,false)=false and coalesce((data->>'emailSkip')::boolean,false)=false and coalesce(data->>'kind','')<>'ugc' and not (data ? 'emailOptout'))::int waiting
        from public.docs where path like 'meets/%/vip/%'`)).rows[0] || {};
      return {...base, people:rows.filter(r => r.key !== "general" && !SEQ_KEYS.includes(r.key)).map(r => ({uid:r.key, email:r.email})), tpl, seq, steps, queue:q};
    });
    res.status(out.status || 200).json(out);
  }catch(err){ res.status(500).json({error:String(err.message || err)}); }
};
