/* Atmosfera: cache do app para abrir sem internet.
   Estratégia: responde pelo cache na hora e atualiza em segundo plano.
   A cada publicação, mude o número de CACHE: é isso que faz o aparelho baixar a versão nova e mostrar o aviso "Atualizar". */
var CACHE = 'atmosfera-v16';
var ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './atmosfera-tons.gs', './atmosfera-tons-worker.js',
  './atmosfera-worklet.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    // cache:'reload' pula o cache HTTP do navegador: a cópia guardada é sempre a que está no servidor agora
    return Promise.all(ASSETS.map(function (a) {
      return fetch(new Request(a, { cache: 'reload' })).then(function (res) {
        if (!res || !res.ok) throw new Error('falha ao baixar ' + a);
        return c.put(a, res);
      });
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  var own = url.origin === self.location.origin;
  var fonts = /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!own && !fonts) return;
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.ok) c.put(req, res.clone());
        return res;
      }).catch(function () { return null; });
      if (cached) { return cached; }
      return network.then(function (res) { return res || new Response('Sem conexão e sem cópia guardada.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); });
    });
  }));
});
