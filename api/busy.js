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
      const rows = (await c.query(`select split_part(path,'/',2) uid, data from public.docs where path like 'meets/%/items/%'
        and coalesce(data->>'cancelled','') <> 'true' and data->'flow'->>'lostAt' is null`)).rows;
      const busy = [];
      for (const r of rows){
        const d = r.data || {}, f = d.flow || {}, mine = r.uid === me.id;
        const at = d.reschedAt || d.meetAt;
        if (at && !f.inviteDeclinedAt) busy.push({t:ts(at), kind:"pitch", mine});
        if (f.skeletonMeetAt && !f.skeletonAt) busy.push({t:ts(f.skeletonMeetAt), kind:"skel", mine});
        if (f.buildMeetAt && !f.launchedAt) busy.push({t:ts(f.buildMeetAt), kind:"build", mine});
      }
      const board = busy.filter(b => b.t >= from - 3600e3 && b.t <= to);
      let google = [], googleOk = false;
      if (leader){
        try{
          const tok = await accessTokenFor(leader);
          if (tok){
            const q = new URLSearchParams({timeMin:new Date(from).toISOString(), timeMax:new Date(to).toISOString(), singleEvents:"true", orderBy:"startTime", maxResults:"250"});
            const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?" + q, {headers:{authorization:"Bearer " + tok}});
            if (r.ok){ googleOk = true; const j = await r.json();
              google = (j.items || []).filter(e => e.status !== "cancelled" && e.start && e.start.dateTime && e.transparency !== "transparent")
                .map(e => ({t:Date.parse(e.start.dateTime), end:Date.parse(e.end && e.end.dateTime || e.start.dateTime)})); }
          }
        }catch(_){ /* el calendario del leader es opcional */ }
      }
      return {leader, board, google, googleOk};
    });
    res.json(out);
  }catch(err){ res.status(500).json({error:String(err.message || err)}); }
};
