// Спершу мережа, потім кеш: встановлений застосунок завжди отримує свіжу версію,
// а без інтернету відкривається з кешу (грати онлайн без мережі однаково не вийде).
const CACHE = 'bloky-v3';

const FILES = [
  './',
  './index.html',
  './style.css',
  './net.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) {
    return;
  }
  // no-cache: GitHub Pages дозволяє браузеру 10 хвилин тримати старі файли — перепитуємо сервер щоразу
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
