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
    if (!session) session = await loginScreen();
    const r = await sb.from("app_users").select("*").eq("id", session.user.id).maybeSingle();
    me = r.data || {id:session.user.id, email:session.user.email, role:"none"};
    if (me.role === "none" || me.active === false) { blockScreen(me.email); throw new Error("sin acceso"); }
    sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") location.reload(); });
    headerChip();
  })();

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
    const acts = document.querySelector(".tabrow") || document.body;
    const b = document.createElement("button"); b.className = "sg-out"; b.type = "button";
    b.textContent = `${me.name || me.email} · Salir`; b.onclick = () => sb.auth.signOut();
    acts.appendChild(b);
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
    return ({db, user, assets, downloads})[name] || null;
  }};
})();
