const CACHE = 'tippspiel-v7';
const STATIC = ['/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);
    if (url.pathname.startsWith('/api/')) {
        e.respondWith(
            fetch(e.request).catch(() =>
                new Response(JSON.stringify({ error: 'Offline – keine Verbindung.' }),
                    { status: 503, headers: { 'Content-Type': 'application/json' } })
            )
        );
        return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
        e.respondWith(
            fetch(e.request)
                .then(response => {
                    caches.open(CACHE).then(c => c.put(e.request, response.clone()));
                    return response;
                })
                .catch(() => caches.match(e.request))
        );
        return;
    }
    e.respondWith(
        caches.match(e.request).then(cached => {
            if (cached) return cached;
            return fetch(e.request).then(response => {
                if (response.ok) caches.open(CACHE).then(c => c.put(e.request, response.clone()));
                return response;
            });
        })
    );
});

// ── Push Notifications ────────────────────────────────────────────────────────
self.addEventListener('push', e => {
    // event.waitUntil MUSS synchron und sofort aufgerufen werden
    // Alles async darf nur INNERHALB des waitUntil passieren
    e.waitUntil((async () => {
        let title = '⚽ Tippspiel';
        let body  = 'Neue Benachrichtigung';
        let tag   = 'tippspiel';
        try {
            const text = e.data?.text();
            if (text) {
                const d = JSON.parse(text);
                title = d.title || title;
                body  = d.body  || body;
                tag   = d.tag   || tag;
            }
        } catch {}
        return self.registration.showNotification(title, {
            body, tag,
            icon:     '/icon-192.png',
            badge:    '/icon-192.png',
            renotify: true
        });
    })());
});

self.addEventListener('notificationclick', e => {
    e.notification.close();
    const url = e.notification.data?.url || '/';
    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
            const existing = list.find(c => c.url.includes(self.location.origin));
            if (existing) { existing.focus(); return; }
            return clients.openWindow(url);
        })
    );
});
