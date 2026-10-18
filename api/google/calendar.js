// Calendario de quien está usando la página: listar, ver, crear (con Meet) y borrar eventos.
const crypto = require("crypto");
const { userFromReq, accessTokenFor, withPg } = require("../../lib/google");
// Calendarios extra (p. ej. el de otra cuenta compartido con este correo): members/<uid>.extraCals = [{id, name}]
async function extraCals(uid){
  try{ return await withPg(async c => { const r = (await c.query("select data from public.docs where path=$1", ["members/" + uid])).rows[0];
    const l = (r && r.data && r.data.extraCals) || []; return (Array.isArray(l) ? l : []).filter(x => x && x.id).slice(0, 5); }); }catch(_){ return []; }
}
const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const off = (tz) => tz === "America/Cancun" ? "-05:00" : "Z";
const withTz = (s, tz) => /([+-]\d\d:\d\d|Z)$/.test(s) ? s : `${s}${s.length === 16 ? ":00" : ""}${off(tz)}`;
module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  const me = await userFromReq(req);
  if (!me) return res.status(401).json({code:"needs_reauth", error:"Sesión no válida"});
  const tok = await accessTokenFor(me.id);
  if (!tok) return res.status(409).json({code:"server_not_connected", error:"Conecta tu Google Calendar"});
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { op, input = {} } = body, H = {authorization:`Bearer ${tok}`, "content-type":"application/json"};
  try{
    let r;
    if (op === "list_events"){
      const tz = input.timeZone || "America/Cancun";
      const q = new URLSearchParams({singleEvents:"true", orderBy:"startTime", maxResults:String(input.pageSize || 250),
        timeMin: withTz(input.startTime || new Date().toISOString(), tz), ...(input.endTime ? {timeMax: withTz(input.endTime, tz)} : {})});
      const [main, extras] = await Promise.all([fetch(`${API}?${q}`, {headers:H}), extraCals(me.id)]);
      const mj = await main.json().catch(() => ({}));
      if (!main.ok) return res.status(main.status === 401 ? 401 : 502).json({code: main.status === 401 ? "needs_reauth" : "tool_error", error:(mj.error && mj.error.message) || "Error de Google"});
      const out = (mj.items || []).map(x => ({...x, conferenceUrl:x.hangoutLink}));
      const st = await Promise.all(extras.map(async cal => {
        try{ const er = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${q}`, {headers:H});
          const ej = await er.json().catch(() => ({}));
          if (!er.ok) return {id:cal.id, name:cal.name || "", ok:false, error: er.status === 404 || er.status === 403 ? "Todavía no está compartido con este correo" : ((ej.error && ej.error.message) || "Error de Google")};
          (ej.items || []).forEach(x => out.push({...x, conferenceUrl:x.hangoutLink, calName:cal.name || cal.id, extraCal:true}));
          return {id:cal.id, name:cal.name || "", ok:true, n:(ej.items || []).length};
        }catch(e){ return {id:cal.id, name:cal.name || "", ok:false, error:String(e.message || e)}; }
      }));
      return res.json({events:out, extras:st});
    } else if (op === "get_event"){
      r = await fetch(`${API}/${encodeURIComponent(input.eventId)}`, {headers:H});
    } else if (op === "delete_event"){
      r = await fetch(`${API}/${encodeURIComponent(input.eventId)}?sendUpdates=all`, {method:"DELETE", headers:H});
      if (r.status === 204 || r.status === 410) return res.json({ok:true});
    } else if (op === "create_event"){
      const tz = input.timeZone || "America/Cancun";
      const ev = {summary:input.summary, description:input.description || "",
        start:{dateTime:input.startTime, timeZone:tz}, end:{dateTime:input.endTime, timeZone:tz},
        attendees:(input.attendees || []).map(a => ({email:a.email})),
        ...(input.addGoogleMeetUrl ? {conferenceData:{createRequest:{requestId:crypto.randomUUID(), conferenceSolutionKey:{type:"hangoutsMeet"}}}} : {})};
      r = await fetch(`${API}?conferenceDataVersion=1&sendUpdates=all`, {method:"POST", headers:H, body:JSON.stringify(ev)});
    } else return res.status(400).json({code:"bad_request", error:"op no válida"});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status === 401 ? 401 : 502).json({code: r.status === 401 ? "needs_reauth" : "tool_error", error:(j.error && j.error.message) || "Error de Google"});
    if (op === "list_events") return res.json({events:(j.items || []).map(x => ({...x, conferenceUrl:x.hangoutLink}))});
    return res.json({...j, conferenceUrl:j.hangoutLink});
  }catch(err){ return res.status(502).json({code:"server_unavailable", error:String(err.message||err)}); }
};
