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
import { moveTodos, subscribeTodos, cleanupNotes } from './todoService.js';
import { scheduleRender, setPage } from './render.js';
import { flushDirty } from './save.js';
import { applyTheme, applyAccent, applyBgBrightness, applyPattern, applyBannerPhoto, initBannerDrag, initSettings } from './settings.js';

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

// Single module-level listener — avoids accumulation on re-login
document.addEventListener('visibilitychange', () => {
    if (!currentUid) return;
    if (document.visibilityState === 'hidden') {
        flushDirty();
    } else {
        moveTodos(currentUid).catch(e => console.error('moveTodos:', e));
        cleanupNotes(currentUid).catch(e => console.error('cleanupNotes:', e));
    }
});

function showApp() {
    dismissSplash();
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    const tabs = document.getElementById('page-tabs');
    tabs.classList.remove('hidden');
    tabs.querySelectorAll('.page-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            tabs.querySelectorAll('.page-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            setPage(btn.dataset.page);
        });
    });
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
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        if (saveInterval) { clearInterval(saveInterval); saveInterval = null; }
        showAuth();
    }
);
