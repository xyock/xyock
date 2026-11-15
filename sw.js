const appScope = new URL(self.registration.scope);
const defaultChatUrl = new URL("xyock.html", appScope).href;

self.addEventListener("push", event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }

  const title = String(payload.title || "xyock");
  const options = {
    body: String(payload.body || "Your response is ready"),
    icon: new URL("favicon/web-app-manifest-192x192.png", appScope).href,
    badge: new URL("favicon/favicon-96x96.png", appScope).href,
    tag: payload.taskId ? "xyock-task-" + String(payload.taskId) : "xyock-response-ready",
    renotify: false,
    data: {
      url: String(payload.url || defaultChatUrl)
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const targetUrl = new URL(
    String(event.notification.data?.url || defaultChatUrl),
    appScope
  ).href;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (client.url.startsWith(self.location.origin)) {
        if ("navigate" in client && client.url !== targetUrl) {
          await client.navigate(targetUrl);
        }
        return await client.focus();
      }
    }
    return await self.clients.openWindow(targetUrl);
  })());
});
