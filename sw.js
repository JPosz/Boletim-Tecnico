const CACHE = "boletim-tecnico-v9";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./sync.js"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))
    )
  );
  self.clients.claim();
});

async function pageWithSync(request) {
  let response;

  try {
    response = await fetch(request, { cache: "no-store" });
    const cache = await caches.open(CACHE);
    await cache.put("./index.html", response.clone());
  } catch {
    response = await caches.match("./index.html");
  }

  if (!response) return new Response("Offline", { status: 503 });

  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html")) return response;

  let html = await response.text();

  if (!html.includes('src="./sync.js"')) {
    html = html.replace("</body>", '<script src="./sync.js"></script>\n</body>');
  }

  const headers = new Headers(response.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.delete("content-length");

  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  /*
   * MUITO IMPORTANTE:
   * nunca armazenar respostas de APIs externas no cache do PWA.
   * Antes desta correção as consultas GET do Supabase eram colocadas
   * no Cache Storage. Assim, PC e celular podiam continuar recebendo
   * respostas antigas e pareciam estar conectados a "nuvens diferentes".
   */
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(pageWithSync(event.request));
    return;
  }

  if (url.pathname.endsWith("/sync.js") || url.pathname.endsWith("/sw.js")) {
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then(async response => {
          const cache = await caches.open(CACHE);
          await cache.put(event.request, response.clone());
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(async response => {
        const cache = await caches.open(CACHE);
        await cache.put(event.request, response.clone());
        return response;
      });
    })
  );
});