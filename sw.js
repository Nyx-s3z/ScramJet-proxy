importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
const PREFIX = "/scramjet/";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

async function handleRequest(event) {
  let url;
  try {
    url = new URL(event.request.url);
  } catch {
    return fetch(event.request);
  }

  // Only proxied pages go through Scramjet. Our own files and the connection
  // worker pass straight through, so a config problem can never block them.
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) {
    return fetch(event.request);
  }

  try {
    await scramjet.loadConfig();
    if (scramjet.route(event)) {
      return await scramjet.fetch(event);
    }
  } catch (err) {
    console.error("[emnity] scramjet failed:", err);
    return new Response(
      "<body style=\"font-family:system-ui;background:#e6e8e8;text-align:center;padding-top:15vh\">" +
        "<h2 style=\"color:#0d9488\">Emnity engine error</h2>" +
        "<p>Scramjet couldn't load its settings. Clear this site's data and reload Emnity.</p></body>",
      { status: 500, headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }
  return fetch(event.request);
}

self.addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event));
});
