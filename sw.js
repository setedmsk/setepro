const APP_VERSION = "sete-pro-pwa-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Sete PRO", body: event.data ? event.data.text() : "Atualizacao do seu bilhete." };
  }

  const title = payload.title || "Sete PRO";
  const options = {
    body: payload.body || "Seu bilhete teve uma atualizacao.",
    badge: "/icon.svg",
    icon: "/icon.svg",
    tag: payload.tag || "sete-pro-alert",
    renotify: true,
    data: {
      url: payload.url || "/?acao=acertos",
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/?acao=acertos", self.location.origin).href;

  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clientsList) {
      if ("focus" in client) {
        await client.navigate(targetUrl);
        return client.focus();
      }
    }
    return self.clients.openWindow(targetUrl);
  })());
});
