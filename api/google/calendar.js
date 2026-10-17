// Calendario de quien está usando la página: listar, ver, crear (con Meet) y borrar eventos.
const crypto = require("crypto");
const { userFromReq, accessTokenFor } = require("../../lib/google");
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
      r = await fetch(`${API}?${q}`, {headers:H});
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
