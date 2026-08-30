const CACHE_NAME = 'todo-v104';

const PRECACHE = [
    './',
    './index.html',
    './styles.css',
    './src/app.js',
    './src/firebase.js',
    './src/auth.js',
    './src/render.js',
    './src/notes.js',
    './src/dragdrop.js',
    './src/save.js',
    './src/store.js',
    './src/selection.js',
    './src/history.js',
    './src/feedback.js',
    './src/settings.js',
    './src/todoService.js',
    './src/i18n.js',
    './src/charts.js',
    './src/animations.js',
    './src/version.js',
    'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
    'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js',
    'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js',
    'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js',
];

// On install: cache all app shell files.
// cache: 'reload' makes every precache request bypass the browser's HTTP cache —
// GitHub Pages serves with max-age=600, so within 10 minutes of a deploy addAll
// would otherwise happily mix stale files into the brand-new cache (e.g. an old
// version.js next to a new render.js).
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            cache.addAll(PRECACHE.map(url => new Request(url, { cache: 'reload' })))
        )
    );
    self.skipWaiting(); // Force update for this transition
});

// Listen for skipWaiting message from UI
self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

// On activate: delete old caches so updates roll out immediately
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Fetch: cache-first for app shell, network-only for Firebase API calls
self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    // Let Firebase API traffic go straight to the network
    if (
        url.hostname.includes('firestore.googleapis.com') ||
        url.hostname.includes('identitytoolkit.googleapis.com') ||
        url.hostname.includes('securetoken.googleapis.com') ||
        url.hostname.includes('firebase.googleapis.com')
    ) return;

    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) return cached;
            return fetch(event.request).then(response => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            });
        })
    );
});
