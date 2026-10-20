/* STRIKD Growth · runtime propio sobre Supabase.
   Implementa la misma interfaz que el tablero usaba en claude.ai (window.claude.use("db"|"user"|"assets"|"downloads"))
   para que index.html funcione igual en growth.strikd.ai, con login de STRIKD. */
(function(){
  // la config pública (URL y anon key) se guarda: las siguientes veces no se espera al servidor
  const CFG_NET = fetch("/api/config").then(r => r.json()).then(j => { try{ if (j.url && j.anonKey) localStorage.setItem("strikd_cfg", JSON.stringify(j)); }catch(_){} return j; });
  CFG_NET.catch(() => {});
  const CFG = (() => { try{ const c = JSON.parse(localStorage.getItem("strikd_cfg") || "null"); if (c && c.url && c.anonKey) return Promise.resolve(c); }catch(_){} return CFG_NET; })();
  let sb, session = null, me = null;
  const ready = (async () => {
    const cfg = await CFG;
    if (!cfg.url || !cfg.anonKey) throw new Error("Falta configurar Supabase en Vercel");
    // lock propio: en iPhone (app instalada) el candado del navegador a veces se queda trabado y el inicio de sesión no avanza
    const memLocks = {};
    const lock = async (name, _t, fn) => { const prev = memLocks[name] || Promise.resolve(); let rel; const cur = new Promise(r => rel = r); memLocks[name] = prev.then(() => cur);
      await Promise.race([prev, new Promise(r => setTimeout(r, 5000))]); try{ return await fn(); } finally { rel(); } };
    sb = window.supabase.createClient(cfg.url, cfg.anonKey, {auth:{persistSession:true, detectSessionInUrl:true, lock}});
    window.STRIKD_SB = sb;
    const { data } = await sb.auth.getSession();
    session = data.session;
    const hash = location.hash || "";
    if (session && /type=(invite|recovery)/.test(hash)) await passwordScreen(hash.includes("invite") ? "Bienvenido a STRIKD Growth" : "Nueva contraseña");
    if (!session){
      const st = await fetch("/api/setup").then(r => r.json()).catch(() => ({}));
      if (st.needsSetup) await setupScreen();
      session = await loginScreen();
    }
    const r = await sb.from("app_users").select("*").eq("id", session.user.id).maybeSingle();
    me = r.data || {id:session.user.id, email:session.user.email, role:"none"};
    if (me.role === "none" || me.active === false) { blockScreen(me.email); throw new Error("sin acceso"); }
    sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") location.reload(); });
    // estado de Google: si ya lo conocemos de la vez pasada, se entra de inmediato y se actualiza en segundo plano
    const gKey = "strikd_google_" + me.id;
    const gFetch = fetch("/api/google/status", {headers:{authorization:"Bearer " + session.access_token}}).then(r => r.ok ? r.json() : Promise.reject())
      .then(j => { try{ localStorage.setItem(gKey, JSON.stringify(j)); }catch(_){} return j; });
    let gCached = null; try{ gCached = JSON.parse(localStorage.getItem(gKey) || "null"); }catch(_){}
    if (gCached){ google = gCached; gFetch.then(j => { const was = !!google.connected; google = j; if (was !== !!j.connected) location.reload(); else headerChip(); }).catch(() => {}); }
    else { try{ google = await Promise.race([gFetch, new Promise((_, rej) => setTimeout(rej, 4000))]); }catch(_){ google = {}; gFetch.then(j => { google = j; headerChip(); }).catch(() => {}); } }
    headerChip();
    if (me.role === "head" && localStorage.getItem("strikd_cron") !== "2"){ fetch("/api/push-cron", {method:"POST", headers:{authorization:"Bearer " + session.access_token}}).then(r => { if (r.ok) localStorage.setItem("strikd_cron", "2"); }).catch(() => {}); }
    const gq = new URLSearchParams(location.search).get("google");
    if (gq){ history.replaceState(null, "", location.pathname); if (gq === "extra") setTimeout(() => alert("✓ Cuenta conectada. Sus eventos ya salen en tu agenda con su título y link de Meet."), 300); else if (gq === "gmail") setTimeout(() => alert("✓ Gmail conectado para los emails automáticos."), 300); else if (gq !== "ok") setTimeout(() => alert(gq === "cancelado" ? "No se conectó Google Calendar (cancelaste el permiso)." : "No se pudo conectar Google Calendar. Intenta de nuevo."), 300); }
  })();
  let google = {};

  /* ---------- pantallas de acceso ---------- */
  function shell(inner){
    let el = document.getElementById("sgAuth");
    if (!el){ el = document.createElement("div"); el.id = "sgAuth"; document.body.appendChild(el); }
    el.innerHTML = `<div class="sg-card"><div class="sg-brand">OUTREACH <span>x</span> STRIKD</div>${inner}</div>`;
    if (window.STRIKD_SPLASH_HIDE) window.STRIKD_SPLASH_HIDE(); // pantalla de acceso: quitamos el splash
    return el;
  }
  function loginScreen(){
    return new Promise(resolve => {
      const el = shell(`<h2>Entrar</h2>
        <label>Correo<input id="sgEmail" type="email" autocomplete="email"></label>
        <label>Contraseña<input id="sgPass" type="password" autocomplete="current-password"></label>
        <p class="sg-err" id="sgErr"></p>
        <button id="sgGo" class="sg-btn">Entrar</button>
        <button id="sgForgot" class="sg-link">Olvidé mi contraseña</button>
        <a class="sg-link" href="/entrar.html" style="text-align:center">¿No te deja escribir o entrar? Usa la entrada simple</a>`);
      const err = t => { el.querySelector("#sgErr").textContent = t; };
      const go = el.querySelector("#sgGo");
      go.onclick = async () => {
        const email = el.querySelector("#sgEmail").value.trim(), password = el.querySelector("#sgPass").value;
        if (!email || !password) return err("Escribe tu correo y contraseña.");
        if (go.disabled) return;
        go.disabled = true; go.textContent = "Entrando…"; err("");
        let res;
        try{ res = await Promise.race([sb.auth.signInWithPassword({email, password}), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000))]); }
        catch(e){ res = {error:{message: e && e.message === "timeout" ? "timeout" : "net"}}; }
        go.disabled = false; go.textContent = "Entrar";
        const { data, error } = res;
        if (error) return err(error.message.includes("Invalid") ? "Correo o contraseña incorrectos." : error.message === "timeout" ? "Está tardando mucho. Revisa tu internet y vuelve a intentar." : "No se pudo entrar. Intenta de nuevo.");
        el.remove(); resolve(data.session);
      };
      el.querySelector("#sgPass").addEventListener("keydown", e => { if (e.key === "Enter") el.querySelector("#sgGo").click(); });
      el.querySelector("#sgForgot").onclick = async () => {
        const email = el.querySelector("#sgEmail").value.trim();
        if (!email) return err("Escribe tu correo arriba y vuelve a picar aquí.");
        await sb.auth.resetPasswordForEmail(email, {redirectTo: location.origin});
        err("Si el correo existe, te llegó un link para crear una contraseña nueva.");
      };
    });
  }
  function setupScreen(){
    return new Promise(resolve => {
      const el = shell(`<h2>Configurar STRIKD Growth</h2><p class="sg-sub">Primera vez: crea tu cuenta de Head. Esto prepara la base de datos y carga tus datos.</p>
        <label>Tu nombre<input id="suName" autocomplete="name"></label>
        <label>Correo<input id="suEmail" type="email" autocomplete="email"></label>
        <label>Contraseña<input id="suPass" type="password" autocomplete="new-password"></label>
        <p class="sg-err" id="sgErr"></p><button id="sgGo" class="sg-btn">Configurar</button>`);
      el.querySelector("#sgGo").onclick = async () => {
        const b = el.querySelector("#sgGo"), e = el.querySelector("#sgErr");
        b.disabled = true; b.textContent = "Configurando… (unos segundos)"; e.textContent = "";
        const r = await fetch("/api/setup", {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({name:el.querySelector("#suName").value, email:el.querySelector("#suEmail").value, password:el.querySelector("#suPass").value})});
        const j = await r.json().catch(() => ({}));
        if (!r.ok){ b.disabled = false; b.textContent = "Configurar"; e.textContent = j.error || "No se pudo configurar."; return; }
        el.remove(); resolve();
      };
    });
  }
  function passwordScreen(title){
    return new Promise(resolve => {
      const el = shell(`<h2>${title}</h2><p class="sg-sub">Crea tu contraseña para entrar.</p>
        <label>Contraseña<input id="sgP1" type="password" autocomplete="new-password"></label>
        <label>Repítela<input id="sgP2" type="password" autocomplete="new-password"></label>
        <p class="sg-err" id="sgErr"></p><button id="sgGo" class="sg-btn">Guardar y entrar</button>`);
      el.querySelector("#sgGo").onclick = async () => {
        const a = el.querySelector("#sgP1").value, b = el.querySelector("#sgP2").value, e = el.querySelector("#sgErr");
        if (a.length < 8) return e.textContent = "Usa al menos 8 caracteres.";
        if (a !== b) return e.textContent = "No coinciden.";
        const { error } = await sb.auth.updateUser({password:a});
        if (error) return e.textContent = "No se pudo guardar. Intenta de nuevo.";
        history.replaceState(null, "", location.pathname); el.remove(); resolve();
      };
    });
  }
  function blockScreen(email){
    const el = shell(`<h2>Sin acceso todavía</h2><p class="sg-sub">${email} no tiene invitación a STRIKD Growth. Pídele al Head que te invite desde el Organigrama.</p><button id="sgOut" class="sg-btn">Salir</button>`);
    el.querySelector("#sgOut").onclick = () => sb.auth.signOut();
    const bm = document.getElementById("bootMsg"); if (bm) bm.hidden = true;
  }
  function headerChip(){
    // el menú solo lleva "Salir"; Google, contraseña, notificaciones y tema viven en Ajustes (STRIKD_ACT)
    const acts = document.getElementById("amAcct") || document.querySelector(".tabrow") || document.body;
    const outBox = document.getElementById("amOut") || acts;
    const b = document.createElement("button"); b.className = "sg-out"; b.type = "button";
    b.textContent = document.getElementById("amOut") ? "Salir" : `${me.name || me.email} · Salir`; b.onclick = () => sb.auth.signOut();
    outBox.appendChild(b);
    const ab = document.getElementById("acctBtn");
    if (ab && google.configured !== false && !google.connected){ const d = document.createElement("span"); d.className = "dot"; d.title = "Conecta tu Google Calendar"; ab.appendChild(d); }
  }
  async function pushDiag(){
    const t = (await sb.auth.getSession()).data.session.access_token;
    const j = await fetch("/api/push-status", {headers:{authorization:"Bearer " + t}}).then(r => r.json()).catch(e => ({error:String(e)}));
    const runs = (j.ultimas_ejecuciones || []).map(x => `${x.status} ${new Date(x.start_time).toLocaleTimeString("es-MX")}`).join(", ") || "ninguna todavía";
    const http = (j.ultimas_respuestas || []).map(x => `${x.status_code || "—"} ${x.respuesta || ""}`).join("\n") || "ninguna todavía";
    const devs = (j.dispositivos || []).map(x => `• ${x.persona}: ${x.dispositivos} dispositivo(s)`).join("\n") || "Nadie ha activado notificaciones.";
    alert(j.error ? "Error: " + j.error : `Revisión cada minuto: ${j.revision_programada ? "✅ activa" : "❌ no está activa"}${j.se_programo_ahora ? " (se activó ahora)" : ""}\nÚltimas ejecuciones: ${runs}\nRespuestas:\n${http}\n\nDispositivos:\n${devs}\n\nReporte diario:\n${(j.reporte_diario||[]).map(x => `${x.day} · ${x.persona}: ${x.dispositivos_que_recibieron == null ? "enviado (sin detalle)" : x.dispositivos_que_recibieron ? "✅ llegó a " + x.dispositivos_que_recibieron + " dispositivo(s)" : "❌ " + (x.nota || "no llegó")}`).join("\n") || "(todavía no se ha mandado)"}${j.errores ? "\n\nErrores: " + j.errores.join(" | ") : ""}`);
  }
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = () => window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  window.STRIKD_ACT = {
    google: () => google,
    googleConnect: async () => {
      if (google.configured === false) return alert("Google Calendar todavía no está activado en el servidor. El Head tiene que poner las llaves de Google en Vercel.");
      const t = (await sb.auth.getSession()).data.session.access_token; location.href = "/api/google/connect?token=" + encodeURIComponent(t);
    },
    // otra cuenta de Google (p. ej. la de otro trabajo), conectada directo para leer su calendario completo
    googleConnectExtra: async (name) => {
      const t = (await sb.auth.getSession()).data.session.access_token;
      location.href = "/api/google/connect?token=" + encodeURIComponent(t) + "&extra=" + encodeURIComponent(name || "");
    },
    googleForgetExtra: async (email) => {
      const t = (await sb.auth.getSession()).data.session.access_token;
      await fetch("/api/google/status", {method:"POST", headers:{authorization:"Bearer " + t, "content-type":"application/json"}, body:JSON.stringify({extra:email})}).catch(() => {});
    },
    googleDisconnect: async () => {
      if (!confirm("¿Desconectar tu Google Calendar? Ya no podrás agendar meets hasta volver a conectarlo.")) return;
      const t = (await sb.auth.getSession()).data.session.access_token; await fetch("/api/google/status", {method:"POST", headers:{authorization:"Bearer " + t}}); location.reload();
    },
    password: () => passwordScreen("Cambiar contraseña"),
    logout: () => sb.auth.signOut(),
    pushSupported: () => "serviceWorker" in navigator && "PushManager" in window && !!window.Notification,
    pushOn: () => !!(window.Notification && Notification.permission === "granted" && localStorage.getItem("strikd_push") === "1"),
    pushBlocked: () => !!(window.Notification && Notification.permission === "denied"),
    needsInstall: () => isIOS && !standalone(),
    isIOS, standalone,
    pushEnable: () => pushEnable(),
    pushDiag,
  };


  /* ---------- db: colecciones y documentos ---------- */
  const listeners = new Set();
  let channel = null, refetchT = null;
  function ensureChannel(){
    if (channel) return;
    channel = sb.channel("docs").on("postgres_changes", {event:"*", schema:"public", table:"docs"}, (p) => {
      const path = (p.new && p.new.path) || (p.old && p.old.path) || "";
      const parent = path.replace(/\/[^/]+$/, "");
      listeners.forEach(l => { if ((l.kind === "col" && l.path === parent) || (l.kind === "doc" && l.path === path) || !path) l.dirty = true; });
      clearTimeout(refetchT); refetchT = setTimeout(() => listeners.forEach(l => { if (l.dirty){ l.dirty = false; l.fetch(); } }), 120);
    }).subscribe();
    // red de seguridad: si se pierde un evento, refresca cada 30 s
    setInterval(() => listeners.forEach(l => l.fetch()), 30000);
  }
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(15)), b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  function docSnap(row, id){ return {id, exists:!!row, data:() => row ? row.data : undefined, metadata:{}}; }
  function docRef(path){
    const id = path.split("/").pop();
    return {
      id, path,
      async get(){ const { data } = await sb.from("docs").select("data,version").eq("path", path).maybeSingle(); return docSnap(data, id); },
      async set(data){ const { error } = await sb.from("docs").upsert({path, data, updated_at:new Date().toISOString()}); if (error) throw {code:"invalid_argument", message:error.message}; },
      async update(patch){ const { error } = await sb.rpc("doc_update", {p:path, patch}); if (error) throw {code: error.code === "P0002" ? "not_found" : "invalid_argument", message:error.message}; },
      async delete(){ const { error } = await sb.from("docs").delete().eq("path", path); if (error) throw {code:"invalid_argument", message:error.message}; },
      async acquire(){ return {acquired:true}; },
      collection(c){ return colRef(path + "/" + c); },
      onSnapshot(next, err){
        ensureChannel();
        const l = {kind:"doc", path, dirty:false, fetch: async () => { const { data, error } = await sb.from("docs").select("data").eq("path", path).maybeSingle(); if (error){ err && err(error); return; } next(docSnap(data, id)); }};
        listeners.add(l); l.fetch(); return () => listeners.delete(l);
      }
    };
  }
  function colRef(path){
    return {
      path, id:path.split("/").pop(),
      doc(id){ return docRef(path + "/" + (id || rid())); },
      onSnapshot(next, err){
        ensureChannel();
        const l = {kind:"col", path, dirty:false, fetch: async () => {
          const { data, error } = await sb.from("docs").select("id,data").eq("parent", path).limit(5000);
          if (error){ err && err(error); return; }
          next({docs:(data||[]).map(r => docSnap(r, r.id)), size:(data||[]).length, empty:!(data||[]).length});
        }};
        listeners.add(l); l.fetch(); return () => listeners.delete(l);
      },
      async get(){ const { data } = await sb.from("docs").select("id,data").eq("parent", path); return {docs:(data||[]).map(r => docSnap(r, r.id))}; }
    };
  }
  const db = {collection:colRef, doc:docRef};

  /* ---------- user ---------- */
  const user = {
    id: async () => me.id,
    me: async () => ({id:me.id, name:me.name, email:me.email}),
    isOwner: async () => me.role === "head",
    canEdit: async () => me.role === "head" || me.role === "manager",
    can: async (n) => n === "data.write" ? me.role !== "none" : null,
    profiles: async (ids) => {
      const real = (ids||[]).filter(x => /^[0-9a-f-]{36}$/.test(x));
      if (!real.length) return {};
      const { data } = await sb.from("app_users").select("id,name,email").in("id", real);
      return Object.fromEntries((data||[]).map(u => [u.id, {name:u.name || u.email, avatarUrl:"", email:u.email || ""}]));
    },
    role: () => me.role
  };

  /* ---------- archivos ---------- */
  const assets = {
    async upload(file){
      if (file.size > 20*1024*1024) throw {code:"too_large"};
      const ext = (file.name.match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase();
      const id = crypto.randomUUID().replace(/-/g, "") + ext;
      const { error } = await sb.storage.from("assets").upload(id, file, {contentType:file.type || undefined});
      if (error) throw {code: /mime|type/i.test(error.message) ? "unsupported_type" : "upload_failed", message:error.message};
      return {id, url:"/_blob/" + id, sizeBytes:file.size, contentType:file.type};
    }
  };

  /* ---------- descargas ---------- */
  const downloads = {
    async save({filename, data}){
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
  };

  /* ---------- Google Calendar (misma interfaz que el conector de claude.ai) ---------- */
  async function gcall(tool, input){
    const t = (await sb.auth.getSession()).data.session.access_token;
    const r = await fetch("/api/google/calendar", {method:"POST", headers:{"content-type":"application/json", authorization:"Bearer " + t}, body:JSON.stringify({op:tool, input})});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw {code: j.code || "upstream_error", message: j.error || "Error", retryable: j.code === "server_unavailable"};
    return {content:[], payload:j};
  }
  const mcp = {
    callTool: (server, tool, input) => gcall(tool, input || {}),
    watchTool(server, tool, input, handler, opts){
      let stop = false;
      const run = () => gcall(tool, input || {}).then(r => { if (!stop) handler({type:"data", result:r}); }, e => { if (!stop) handler({type:"error", error:e}); });
      setTimeout(run, 0);
      const iv = setInterval(run, Math.max(60e3, (opts && opts.refetchInterval) || 300e3));
      return () => { stop = true; clearInterval(iv); };
    },
    async listTools(){ return {servers:[{server:"Google Calendar", authStatus:"connected", tools:[]}]}; },
    async invalidate(){}
  };
  window.STRIKD_GOOGLE = () => google;
  window.STRIKD_ME = () => me;
  /* ---------- app en el teléfono y notificaciones ---------- */
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  /* ---------- actualización automática: si hay versión nueva, se recarga sola ---------- */
  let updBusy = false, updLast = 0;
  async function checkUpdate(){
    if (updBusy || !window.STRIKD_BUILD || Date.now() - updLast < 20e3) return;
    updBusy = true; updLast = Date.now();
    try{
      const v = (await fetch("/version.txt?t=" + Date.now(), {cache:"no-store"}).then(r => r.ok ? r.text() : "")).trim();
      if (!v || v === window.STRIKD_BUILD) return;
      const a = document.activeElement, typing = a && a.matches && a.matches("input,textarea,select") && String(a.value || "").length > 0;
      const busy = typing || document.querySelector(".rs-wrap:not([hidden]), .bk-wrap, #sgAuth");
      if (!busy){ location.reload(); return; }
      if (!document.getElementById("updBar")){
        const b = document.createElement("button"); b.id = "updBar"; b.type = "button"; b.className = "upd-bar";
        b.textContent = "Hay una versión nueva · tocar para actualizar"; b.onclick = () => location.reload(); document.body.appendChild(b);
      }
    }catch(_){ } finally{ updBusy = false; }
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkUpdate(); });
  window.addEventListener("focus", checkUpdate); window.addEventListener("pageshow", checkUpdate);
  setInterval(() => { if (document.visibilityState === "visible") checkUpdate(); }, 120e3);
  // al abrir la app se limpia el número del ícono (la bandeja ya muestra lo pendiente)
  const clearBadge = () => { if (document.visibilityState === "visible" && navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {}); };
  document.addEventListener("visibilitychange", clearBadge); clearBadge();
  if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", e => { if (e.data && e.data.type === "open" && window.STRIKD_OPEN) window.STRIKD_OPEN(e.data.url); });
  const b64 = s => { const p = "=".repeat((4 - s.length % 4) % 4), r = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from([...r].map(ch => ch.charCodeAt(0))); };
  async function pushEnable(){
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent), standalone = window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
    if (ios && !standalone) return alert("Para recibir notificaciones en iPhone:\n\n1. Abre growth.strikd.ai en Safari.\n2. Toca Compartir (el cuadro con flecha ↑).\n3. Elige «Agregar a inicio».\n4. Abre STRIKD desde el ícono nuevo y vuelve a tocar «Activar notificaciones».");
    if (!("PushManager" in window) || !window.Notification) return alert("Este navegador no permite notificaciones. En iPhone necesitas iOS 16.4 o más nuevo.");
    const t = (await sb.auth.getSession()).data.session.access_token, H = {"content-type":"application/json", authorization:"Bearer " + t};
    try{
      if (Notification.permission === "granted" && localStorage.getItem("strikd_push") === "1"){ await fetch("/api/push", {method:"POST", headers:H, body:JSON.stringify({test:true})}); return; }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return alert("No diste permiso. Puedes activarlo después en Ajustes → Notificaciones → STRIKD.");
      const reg = await navigator.serviceWorker.ready;
      const k = await fetch("/api/push", {headers:H}).then(r => r.json());
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:b64(k.publicKey)});
      const r = await fetch("/api/push", {method:"POST", headers:H, body:JSON.stringify({subscription:sub.toJSON()})});
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "no se guardó");
      localStorage.setItem("strikd_push", "1");
      if (me.role === "head") fetch("/api/push-cron", {method:"POST", headers:H}).catch(() => {});
      await fetch("/api/push", {method:"POST", headers:H, body:JSON.stringify({test:true})});
    }catch(e){ alert("No se pudieron activar las notificaciones: " + (e.message || e)); }
  }
  window.STRIKD_PUSH = pushEnable;
  window.STRIKD_UPLOAD = async (blob, name) => {
    const t = (await sb.auth.getSession()).data.session.access_token;
    const data = await new Promise((ok, ko) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(",")[1] || ""); fr.onerror = ko; fr.readAsDataURL(blob); });
    const r = await fetch("/api/upload", {method:"POST", headers:{"content-type":"application/json", authorization:"Bearer " + t}, body:JSON.stringify({name, type:blob.type, data})});
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ("Error " + r.status)); return j;
  };
  window.STRIKD_BUSY = async (from, to) => {
    const t = (await sb.auth.getSession()).data.session.access_token;
    const r = await fetch(`/api/busy?from=${from}&to=${to}`, {headers:{authorization:"Bearer " + t}});
    if (!r.ok) throw new Error("busy " + r.status); return r.json();
  };
  // ISKRA (WhatsApp): {configured:false} | {data} | lanza {message, detail}
  window.STRIKD_ISKRA = async (op, input) => {
    const t = (await sb.auth.getSession()).data.session.access_token;
    const r = await fetch("/api/iskra", {method:"POST", headers:{"content-type":"application/json", authorization:"Bearer " + t}, body:JSON.stringify({op, input:input||{}})});
    const j = await r.json().catch(() => ({error:"Respuesta inválida (" + r.status + ")"}));
    if (!r.ok) throw Object.assign(new Error(j.error || ("Error " + r.status)), {status:r.status, detail:j.detail});
    return j;
  };
  window.STRIKD_GOOGLE_USERS = async () => { const t = (await sb.auth.getSession()).data.session.access_token; const r = await fetch("/api/google/status?all=1", {headers:{authorization:"Bearer " + t}}); return r.ok ? (await r.json()).users || [] : []; };

  /* ---------- avisos al celular (tareas) ---------- */
  window.STRIKD_NOTIFY = async (payload) => {
    try{ const { data } = await sb.auth.getSession();
      await fetch("/api/notify", {method:"POST", headers:{"content-type":"application/json", authorization:"Bearer " + data.session.access_token}, body:JSON.stringify(payload)}); }catch(_){}
  };
  // borrar datos de ejemplo (solo Head): dry=true solo cuenta
  window.STRIKD_CLEANUP = async (dry) => {
    const { data } = await sb.auth.getSession();
    const r = await fetch("/api/cleanup", {method: dry ? "GET" : "POST", headers:{"content-type":"application/json", authorization:"Bearer " + data.session.access_token}, ...(dry ? {} : {body:JSON.stringify({confirm:true})})});
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "No se pudo"); return j;
  };
  // reporte diario: mandármelo ahora como notificación (prueba)
  window.STRIKD_REPORT_TEST = async () => {
    const { data } = await sb.auth.getSession();
    const r = await fetch("/api/report", {method:"POST", headers:{authorization:"Bearer " + data.session.access_token}});
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "No se pudo"); return j;
  };
  /* ---------- Mich agenda el meet de un influencer a nombre del AM que lo propuso ---------- */
  window.STRIKD_MICHMEET = async (payload) => {
    const { data } = await sb.auth.getSession();
    const r = await fetch("/api/michmeet", {method:"POST", headers:{"content-type":"application/json", authorization:"Bearer " + data.session.access_token}, body:JSON.stringify(payload)});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "No se pudo guardar");
    return j;
  };
  /* ---------- invitaciones (Head) ---------- */
  window.STRIKD_INVITE = async (email, name, role) => {
    const { data } = await sb.auth.getSession();
    const r = await fetch("/api/invite", {method:"POST", headers:{"content-type":"application/json", authorization:"Bearer " + data.session.access_token}, body:JSON.stringify({email, name, role})});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "No se pudo invitar");
    return j;
  };
  /* ---------- Gmail para emails automáticos ---------- */
  window.STRIKD_GMAIL_STATUS = async () => { const t = (await sb.auth.getSession()).data.session.access_token; const r = await fetch("/api/gmail", {headers:{authorization:"Bearer " + t}}); return r.ok ? r.json() : {}; };
  window.STRIKD_GMAIL_CONNECT = async (kind) => { const t = (await sb.auth.getSession()).data.session.access_token; location.href = "/api/google/connect?token=" + encodeURIComponent(t) + "&gmail=" + (kind === "general" ? "general" : "me"); };
  window.STRIKD_GMAIL_DISCONNECT = async (kind) => { const t = (await sb.auth.getSession()).data.session.access_token;
    await fetch("/api/gmail", {method:"POST", headers:{authorization:"Bearer " + t, "content-type":"application/json"}, body:JSON.stringify({disconnect:kind === "general" ? "general" : "me"})}); };
  window.STRIKD_RESETPW = async (uid) => {
    const { data } = await sb.auth.getSession();
    const r = await fetch("/api/invite", {method:"POST", headers:{"content-type":"application/json", authorization:"Bearer " + data.session.access_token}, body:JSON.stringify({resetFor:uid})});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "No se pudo cambiar la contraseña");
    return j;
  };
  window.STRIKD_USERS = async () => { const { data } = await sb.from("app_users").select("id,email,name,role,active"); const inv = await sb.from("invites").select("*"); return {users:data||[], invites:inv.data||[]}; };

  window.claude = { use: async (name) => {
    try{ await ready; }catch(e){ return null; }
    if (name === "mcp") return google && google.connected ? mcp : null;
    return ({db, user, assets, downloads})[name] || null;
  }};
})();
