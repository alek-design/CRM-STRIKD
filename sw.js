// STRIKD Growth · service worker: notificaciones de WhatsApp. No guarda la página en caché (siempre la versión más nueva).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("push", e => {
  let d = {}; try{ d = e.data ? e.data.json() : {}; }catch(_){ d = {body: e.data && e.data.text()}; }
  if (typeof d.badge === "number" && self.navigator && self.navigator.setAppBadge){ (d.badge > 0 ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge()).catch(() => {}); }
  e.waitUntil(self.registration.showNotification(d.title || "STRIKD", {
    body: d.body || "Tienes un mensaje nuevo", tag: d.tag || "strikd", renotify: true,
    icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: {url: d.url || "/?tab=msgs"}
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/?tab=msgs";
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({type: "window", includeUncontrolled: true});
    for (const c of all){ if ("focus" in c){ await c.focus(); c.postMessage({type: "open", url}); return; } }
    await self.clients.openWindow(url);
  })());
});
