// Capsid Portal's service worker: phone alerts only (src/push.ts). It shows each alert the
// Worker sends and, when one is tapped, opens the item it names on the Portal. It caches nothing and answers no
// fetch, so the Portal loads exactly as it does without it. An alert never carries an
// action button: every answer is given in the Portal.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let alert = { title: "Capsid", body: "Something needs you.", url: self.registration.scope, tag: "capsid" };
  try {
    alert = { ...alert, ...event.data.json() };
  } catch {
    // An alert that is not JSON still says something needs you.
  }
  event.waitUntil(self.registration.showNotification(alert.title, { body: alert.body, tag: alert.tag, data: { url: alert.url } }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // A tap opens only a page on the Portal's own scope; any other url opens the Portal itself.
  const scope = self.registration.scope;
  let url = scope;
  const raw = event.notification.data && event.notification.data.url;
  try {
    const asked = typeof raw === "string" ? new URL(raw, scope).href : scope;
    if (asked.startsWith(scope)) url = asked;
  } catch {
    // A url that does not parse opens the Portal.
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      // A Portal tab already open moves to the item, so the tap never lands on a page
      // that says nothing about it. A tab that cannot be moved is only brought forward.
      for (const w of windows) {
        if (!w.url.startsWith(scope) || !("focus" in w)) continue;
        if (!("navigate" in w)) return w.focus();
        return w.navigate(url).then((moved) => (moved || w).focus(), () => w.focus());
      }
      return self.clients.openWindow(url);
    })
  );
});
