// Horarios ocupados del team leader de quien agenda (para no encimar meets).
// Solo regresa horas, nunca nombres de prospectos: el Account Manager no ve los meets de otros.
//  · board: pitches, meets de skeleton y lanzamientos del equipo que caen en el rango
//  · google: eventos del Google Calendar del team leader (si lo conectó), solo inicio y fin
const { withPg, userFromReq, accessTokenFor } = require("../lib/google");
const OFF = 5 * 3600e3; // Cancún, UTC-5 todo el año
const ts = s => { const t = Date.parse(String(s || "") + ":00Z"); return isNaN(t) ? NaN : t + OFF; };

module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  const me = await userFromReq(req);
  if (!me) return res.status(401).json({error:"Sesión no válida"});
  const from = Number(req.query.from) || Date.now(), to = Math.min(Number(req.query.to) || from + 8*864e5, from + 31*864e5);
  try{
    const out = await withPg(async c => {
      const role = (await c.query("select data from public.docs where path=$1", ["roles/" + me.id])).rows[0];
      let leader = role && role.data && role.data.managerId;
      if (!leader){
        const m = (await c.query("select split_part(path,'/',2) id from public.docs where path like 'roles/%' and data->>'role'='manager' limit 1")).rows[0];
        leader = m ? m.id : null;
      }
      if (me.role === "manager") leader = me.id;
      const rows = (await c.query(`select split_part(path,'/',2) uid, split_part(path,'/',4) id, data from public.docs where path like 'meets/%/items/%'
        and coalesce(data->>'cancelled','') <> 'true' and data->'flow'->>'lostAt' is null`)).rows;
      // solo los meets del equipo de ese leader (cada AM es de su manager; los que no tienen, del primero); sin validaciones rechazadas
      const roles = {}; (await c.query("select split_part(path,'/',2) id, data from public.docs where path like 'roles/%'")).rows.forEach(r => roles[r.id] = r.data || {});
      const mgrs = Object.keys(roles).filter(u => roles[u].role === "manager"), defMgr = mgrs[0] || null;
      const leaderOf = u => roles[u] && roles[u].role === "manager" ? u : (roles[u] && roles[u].managerId && mgrs.includes(roles[u].managerId) ? roles[u].managerId : defMgr);
      const rejected = new Set((await c.query("select split_part(path,'/',2) id from public.docs where path like 'validations/%' and data->>'status'='rejected'")).rows.map(r => r.id));
      const lead = ["head", "manager"].includes(me.role), names = {};
      if (lead) (await c.query("select id, name, email from public.app_users")).rows.forEach(u => names[u.id] = String(u.name || u.email || "").split(" ")[0]);
      const busy = [];
      for (const r of rows){
        const d = r.data || {}, f = d.flow || {}, mine = r.uid === me.id;
        if (leader && leaderOf(r.uid) !== leader && !mine) continue;
        const lab = k => lead ? `${k} · ${d.prospect || "prospecto"}${names[r.uid] ? " (" + names[r.uid] + ")" : ""}` : undefined;
        const at = d.reschedAt || d.meetAt;
        if (at && !d.noMeet && !f.inviteDeclinedAt && !rejected.has(r.id)) busy.push({t:ts(at), kind:"pitch", mine, why:lab("Pitch")});
        if (f.skeletonMeetAt && !f.skeletonAt) busy.push({t:ts(f.skeletonMeetAt), kind:"skel", mine, why:lab("Skeleton")});
        if (f.buildMeetAt && !f.launchedAt) busy.push({t:ts(f.buildMeetAt), kind:"build", mine, why:lab("Lanzamiento")});
      }
      const board = busy.filter(b => b.t >= from - 3600e3 && b.t <= to);
      // lo que cada quien agregó a mano a su agenda (botón + de Agenda): cuenta como bloque ocupado, para quien agenda y para su leader
      const who = [...new Set([me.id, leader].filter(Boolean))];
      const manual = (await c.query(`select split_part(path,'/',2) uid, data from public.docs where parent = any($1)
        and data->>'kind'='event' and coalesce((data->>'done')::boolean,false)=false and (data->>'at')::bigint between $2 and $3`,
        [who.map(u => `meets/${u}/reminders`), from - 3*3600e3, to])).rows
        .map(r => { const t = Number(r.data.at); return {t, end:t + (Number(r.data.dur) || 30) * 60e3, mine:r.uid === me.id, why:lead || r.uid === me.id ? "Agenda · " + String(r.data.text || "").slice(0, 60) : undefined}; });
      let google = [], googleOk = false;
      if (leader){
        try{
          const tok = await accessTokenFor(leader);
          if (tok){
            const q = new URLSearchParams({timeMin:new Date(from).toISOString(), timeMax:new Date(to).toISOString(), singleEvents:"true", orderBy:"startTime", maxResults:"250"});
            const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?" + q, {headers:{authorization:"Bearer " + tok}});
            if (r.ok){ googleOk = true; const j = await r.json();
              // no cuentan: cancelados, "disponible", los que el leader rechazó, ni la ubicación de trabajo
              google = (j.items || []).filter(e => e.status !== "cancelled" && e.start && e.start.dateTime && e.transparency !== "transparent"
                  && !(e.attendees || []).some(a => a.self && a.responseStatus === "declined") && !["workingLocation", "birthday"].includes(e.eventType))
                .map(e => ({t:Date.parse(e.start.dateTime), end:Date.parse(e.end && e.end.dateTime || e.start.dateTime), why:lead || leader === me.id ? "Google · " + String(e.summary || "Ocupado").slice(0, 60) : undefined})); }
          }
        }catch(_){ /* el calendario del leader es opcional */ }
      }
      return {leader, board, google, googleOk, manual};
    });
    res.json(out);
  }catch(err){ res.status(500).json({error:String(err.message || err)}); }
};
