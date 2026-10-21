import { VERSION } from './version.js';

// --- Force Update Logic ---
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then(reg => {
        reg.update(); // Poke the SW to check for changes
        
        // If we've been waiting for an update for a while, just force it
        // This is a one-time bridge to get off old versions
        if (reg.waiting && !window.sessionStorage.getItem('todo-force-reloaded')) {
            window.sessionStorage.setItem('todo-force-reloaded', 'true');
            reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
    });
}

import { initAuth, renderAuthScreen, signOutUser } from './auth.js';
import { initCharts } from './charts.js';
import { moveTodos, subscribeTodos, cleanupNotes, getTodayEpoch } from './todoService.js';
import { scheduleRender, setPage, renderApp } from './render.js';
import { flushDirty } from './save.js';
import { todos, dirtyIds } from './store.js';
import { applyTheme, applyAccent, applyBgBrightness, applyPattern, applyBannerPhoto, initBannerDrag, initSettings } from './settings.js';
import { initHistory, clearHistory } from './history.js';
import { initSelection, clearSelection } from './selection.js';

let unsubscribe = null;
let currentUid = null;
let saveInterval = null;

applyTheme();
applyAccent();
applyBgBrightness();
applyPattern();
applyBannerPhoto();
initBannerDrag();
document.getElementById('version-label').textContent = VERSION;

// Splash: wait for spin-in to finish, then allow dismiss
const splashDone = new Promise(resolve => {
    const icon = document.getElementById('splash-icon');
    icon ? icon.addEventListener('animationend', resolve, { once: true }) : resolve();
});

function dismissSplash() {
    splashDone.then(() => {
        const icon = document.getElementById('splash-icon');
        if (!icon || icon.classList.contains('exit')) return;
        icon.classList.add('exit');
        icon.addEventListener('animationend', () => document.getElementById('splash')?.remove(), { once: true });
    });
}

// pagehide is more reliable than beforeunload for async-safe save-on-exit
window.addEventListener('pagehide', () => flushDirty());

// --- Day rollover ---
// A tab that just stays open and visible never gets a visibilitychange, so the
// date is checked on a timer too. setInterval is the backstop for sleep/wake
// (timers are paused or throttled then); the midnight timeout makes it exact.
let renderedDay = getTodayEpoch();
let midnightTimer = null;

function checkDay() {
    const today = getTodayEpoch();
    if (today === renderedDay) return;
    renderedDay = today;
    if (!currentUid) return;
    moveTodos(currentUid).catch(e => console.error('moveTodos:', e));
    cleanupNotes(currentUid).catch(e => console.error('cleanupNotes:', e));
    // Render directly: when nothing needs moving no snapshot arrives, and the
    // calendar would keep showing yesterday as today
    renderApp(todos);
    checkForUpdate();
}

function scheduleMidnight() {
    clearTimeout(midnightTimer);
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
    midnightTimer = setTimeout(() => { checkDay(); scheduleMidnight(); }, next - now);
}

scheduleMidnight();
setInterval(checkDay, 60000);
window.addEventListener('focus', checkDay);
window.addEventListener('pageshow', checkDay);

// --- App updates ---
// The browser only looks for a new service worker on navigation, which an
// always-open tab never does — so ask periodically. The new worker activates
// right away (skipWaiting); reloading is then held back until nobody is typing.
let reloadPending = false;

function checkForUpdate() {
    navigator.serviceWorker?.getRegistration().then(reg => reg?.update()).catch(() => {});
}

function canReloadNow() {
    if (document.activeElement?.classList.contains('todo-input')) return false;
    if (dirtyIds.size > 0) return false;
    return !todos.some(t => t.id.startsWith('_pending_'));
}

function reloadWhenSafe() {
    if (!reloadPending) return;
    if (document.visibilityState === 'hidden' || canReloadNow()) {
        reloadPending = false;
        window.location.reload();
    }
}

if ('serviceWorker' in navigator) {
    // No controller yet means this is the very first install — clients.claim()
    // fires controllerchange then, but the page is already running current code
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) return;
        reloadPending = true;
        reloadWhenSafe();
    });
    setInterval(checkForUpdate, 60 * 60000);
    // focusout fires before the next element gains focus — check once it settled
    document.addEventListener('focusout', () => setTimeout(reloadWhenSafe, 3000));
}

// Single module-level listener — avoids accumulation on re-login
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        if (!currentUid) return;
        // Let the pending text writes reach the local cache before a deferred reload
        flushDirty();
        if (reloadPending) setTimeout(reloadWhenSafe, 500);
        return;
    }
    checkDay();
    checkForUpdate();
    if (!currentUid) return;
    moveTodos(currentUid).catch(e => console.error('moveTodos:', e));
    cleanupNotes(currentUid).catch(e => console.error('cleanupNotes:', e));
});

// Wired once at module level — showApp() runs again on every sign-in
document.querySelectorAll('#page-tabs .page-tab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#page-tabs .page-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        setPage(btn.dataset.page);
    });
});

function showApp() {
    dismissSplash();
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.getElementById('page-tabs').classList.remove('hidden');
}

function showAuth() {
    dismissSplash();
    document.getElementById('app').classList.add('hidden');
    renderAuthScreen();
}

initAuth(
    async (user) => {
        // Ignore if already set up for this user
        if (currentUid === user.uid) return;
        currentUid = user.uid;

        showApp();

        document.getElementById('signout-btn').onclick = signOutUser;
        initSettings();
        initCharts();
        initHistory();
        initSelection();

        try { await moveTodos(user.uid); } catch (e) { console.error('moveTodos:', e); }
        try { await cleanupNotes(user.uid); } catch (e) { console.error('cleanupNotes:', e); }

        if (unsubscribe) unsubscribe();
        unsubscribe = subscribeTodos(user.uid, (todos) => {
            scheduleRender(todos);
        });

        if (saveInterval) clearInterval(saveInterval);
        saveInterval = setInterval(flushDirty, 60000);

    },
    () => {
        currentUid = null;
        clearSelection();
        clearHistory();
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        if (saveInterval) { clearInterval(saveInterval); saveInterval = null; }
        showAuth();
    }
);
