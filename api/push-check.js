// Revisión de cada minuto (la llama la base de datos con pg_cron): reporte diario, tareas semanales, recordatorios,
// secuencia de emails a influencers, cierre de semana, responsables de Perfil 1 e importaciones pendientes.
// (Desde el 9 nov 2026 ya no se usa ISKRA / WhatsApp.)
const { withPg } = require("../lib/google");
const { cronKey, init } = require("../lib/push");
const { migrate } = require("../lib/migrate");
const report = require("../lib/report");
const taskrules = require("../lib/taskrules");
const reminders = require("../lib/reminders");
const emailauto = require("../lib/emailauto");
const weekfreeze = require("../lib/weekfreeze");
const perfilresp = require("../lib/perfilresp");
const vipimport = require("../lib/vipimport");
const michdm = require("../lib/michdm");
const step = async (fn) => { try{ return await fn(); }catch(e){ return {error:String(e.message || e)}; } };
module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  try{
    const out = await withPg(async c => {
      await init(c);
      const key = (await cronKey(c)).key;
      if ((req.headers["x-strikd-cron"] || req.query.k) !== key) return {status:403, error:"no autorizado"};
      await migrate(c).catch(() => {});
      const r = {
        reporte:await step(() => report.maybeSend(c)),            // reporte diario de las 9 pm
        semanales:await step(() => taskrules.run(c)),             // tareas que se repiten cada semana
        recordatorios:await step(() => reminders.run(c)),
        emails:await step(() => emailauto.run(c)),                // secuencia de emails a influencers
        semana:await step(() => weekfreeze.run(c)),
        importacion:await step(() => vipimport.run(c)),
        responsables:await step(() => perfilresp.run(c)),
        dmsMich:await step(() => michdm.run(c)),                 // 12, 3 y 6 pm: contador de DMs de Mich (meta 30)
      };
      return {ok:true, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v))};
    });
    res.status(out.status || 200).json(out);
  }catch(err){ res.status(500).json({error:String(err.message || err)}); }
};
