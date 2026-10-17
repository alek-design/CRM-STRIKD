/* STRIKD Growth · runtime propio sobre Supabase.
   Implementa la misma interfaz que el tablero usaba en claude.ai (window.claude.use("db"|"user"|"assets"|"downloads"))
   para que index.html funcione igual en growth.strikd.ai, con login de STRIKD. */
(function(){
  const CFG = fetch("/api/config").then(r => r.json());
  let sb, session = null, me = null;
  const ready = (async () => {
    const cfg = await CFG;
    if (!cfg.url || !cfg.anonKey) throw new Error("Falta configurar Supabase en Vercel");
    sb = window.supabase.createClient(cfg.url, cfg.anonKey, {auth:{persistSession:true, detectSessionInUrl:true}});
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
    try{ google = await fetch("/api/google/status", {headers:{authorization:"Bearer " + session.access_token}}).then(r => r.json()); }catch(_){ google = {}; }
    headerChip();
    if (me.role === "head" && localStorage.getItem("strikd_cron") !== "2"){ fetch("/api/push-cron", {method:"POST", headers:{authorization:"Bearer " + session.access_token}}).then(r => { if (r.ok) localStorage.setItem("strikd_cron", "2"); }).catch(() => {}); }
    const gq = new URLSearchParams(location.search).get("google");
    if (gq){ history.replaceState(null, "", location.pathname); if (gq !== "ok") setTimeout(() => alert(gq === "cancelado" ? "No se conectó Google Calendar (cancelaste el permiso)." : "No se pudo conectar Google Calendar. Intenta de nuevo."), 300); }
  })();
  let google = {};

  /* ---------- pantallas de acceso ---------- */
  function shell(inner){
    let el = document.getElementById("sgAuth");
    if (!el){ el = document.createElement("div"); el.id = "sgAuth"; document.body.appendChild(el); }
    el.innerHTML = `<div class="sg-card"><div class="sg-brand">OUTREACH <span>x</span> STRIKD</div>${inner}</div>`;
    return el;
  }
  function loginScreen(){
    return new Promise(resolve => {
      const el = shell(`<h2>Entrar</h2>
        <label>Correo<input id="sgEmail" type="email" autocomplete="email"></label>
        <label>Contraseña<input id="sgPass" type="password" autocomplete="current-password"></label>
        <p class="sg-err" id="sgErr"></p>
        <button id="sgGo" class="sg-btn">Entrar</button>
        <button id="sgForgot" class="sg-link">Olvidé mi contraseña</button>`);
      const err = t => { el.querySelector("#sgErr").textContent = t; };
      el.querySelector("#sgGo").onclick = async () => {
        const email = el.querySelector("#sgEmail").value.trim(), password = el.querySelector("#sgPass").value;
        if (!email || !password) return err("Escribe tu correo y contraseña.");
        const { data, error } = await sb.auth.signInWithPassword({email, password});
        if (error) return err(error.message.includes("Invalid") ? "Correo o contraseña incorrectos." : "No se pudo entrar. Intenta de nuevo.");
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
    const acts = document.getElementById("amAcct") || document.querySelector(".tabrow") || document.body;
    const outBox = document.getElementById("amOut") || acts;
    const b = document.createElement("button"); b.className = "sg-out"; b.type = "button";
    b.textContent = `${me.name || me.email} · Salir`; b.onclick = () => sb.auth.signOut();
    {
      const g = document.createElement("button"); g.className = "sg-out" + (google.connected ? " on" : " cta"); g.type = "button";
      g.textContent = google.connected ? `✓ Google: ${google.email || "conectado"}` : "Conectar mi Google Calendar";
      g.title = google.connected ? "Toca para desconectar" : "Para crear tus invitaciones con link de Meet";
      g.onclick = async () => {
        if (google.configured === false) return alert("Google Calendar todavía no está activado en el servidor.\n\nEl Head tiene que poner GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en Vercel (Settings → Environment Variables) y hacer Redeploy.");
        if (google.error && !google.connected) return alert("No se pudo revisar Google Calendar: " + google.error);
        const t = (await sb.auth.getSession()).data.session.access_token;
        if (!google.connected) return location.href = "/api/google/connect?token=" + encodeURIComponent(t);
        if (confirm("¿Desconectar tu Google Calendar? Ya no se crearán invitaciones automáticas.")){ await fetch("/api/google/status", {method:"POST", headers:{authorization:"Bearer " + t}}); location.reload(); }
      };
      acts.appendChild(g);
      const ab = document.getElementById("acctBtn");
      if (ab && !google.connected){ const d = document.createElement("span"); d.className = "dot"; d.title = "Conecta tu Google Calendar"; ab.appendChild(d); }
    }
    const c = document.createElement("button"); c.className = "sg-out"; c.type = "button"; c.textContent = "Cambiar contraseña";
    c.onclick = () => passwordScreen("Cambiar contraseña");
    acts.appendChild(c);
    // notificaciones de WhatsApp (iPhone: primero "Agregar a inicio")
    if ("serviceWorker" in navigator){
      const n = document.createElement("button"); n.className = "sg-out"; n.type = "button";
      const label = () => { n.textContent = (window.Notification && Notification.permission === "granted" && localStorage.getItem("strikd_push") === "1") ? "🔔 Notificaciones activadas · probar" : "🔔 Activar notificaciones"; };
      label(); n.onclick = () => pushEnable().then(label); acts.appendChild(n);
    }
    b.textContent = document.getElementById("amOut") ? "Salir" : b.textContent; outBox.appendChild(b);
  }

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
      return Object.fromEntries((data||[]).map(u => [u.id, {name:u.name || u.email, avatarUrl:""}]));
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

  /* ---------- invitaciones (Head) ---------- */
  window.STRIKD_INVITE = async (email, name, role) => {
    const { data } = await sb.auth.getSession();
    const r = await fetch("/api/invite", {method:"POST", headers:{"content-type":"application/json", authorization:"Bearer " + data.session.access_token}, body:JSON.stringify({email, name, role})});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "No se pudo invitar");
    return j;
  };
  window.STRIKD_USERS = async () => { const { data } = await sb.from("app_users").select("id,email,name,role,active"); const inv = await sb.from("invites").select("*"); return {users:data||[], invites:inv.data||[]}; };

  window.claude = { use: async (name) => {
    try{ await ready; }catch(e){ return null; }
    if (name === "mcp") return google && google.connected ? mcp : null;
    return ({db, user, assets, downloads})[name] || null;
  }};
})();
