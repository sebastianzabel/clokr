/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// Push-only service worker (Issue #608, D-12 / D-19).
//
// It does exactly two things: show a notification when a push arrives and open the matching page
// when the notification is tapped. It never touches network requests and keeps no offline copy of
// anything, so it can never serve a stale bundle of the application.

import { parsePushPayload, targetUrlFor } from "$lib/push/payload";

const sw = self as unknown as ServiceWorkerGlobalScope;

function isOperatorPath(pathname: string): boolean {
  return pathname === "/betreiber" || pathname.startsWith("/betreiber/");
}

// Nothing is stored, so a new worker can take over at once without mixing generations.
sw.addEventListener("install", () => {
  void sw.skipWaiting();
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(sw.clients.claim());
});

sw.addEventListener("push", (event) => {
  const payload = parsePushPayload(event.data);
  // Always show something, also when a window is focused or the data is unreadable: iOS counts a
  // push without a visible notification as silent and revokes the subscription after a few.
  event.waitUntil(
    sw.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      lang: "de",
      data: { url: payload.url },
    }),
  );
});

sw.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: unknown } | null | undefined;
  const target = targetUrlFor(data?.url, sw.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
      // A window of the operator console is a different application; never navigate it.
      const client = windows.find((w) => !isOperatorPath(new URL(w.url).pathname));
      if (client) {
        try {
          await client.focus();
          await client.navigate(target);
          return;
        } catch {
          // fall through: open a new window instead
        }
      }
      await sw.clients.openWindow(target);
    })(),
  );
});
