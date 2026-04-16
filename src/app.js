import { initAuth, renderAuthScreen, signOutUser } from './auth.js';
import { moveTodos, subscribeTodos, cleanupNotes } from './todoService.js';
import { scheduleRender, flushDirty, setPage } from './render.js';
import { applyTheme, applyAccent, initSettings, initReminder } from './settings.js';
import { VERSION } from './version.js';

let unsubscribe = null;
let currentUid = null;
let saveInterval = null;

applyTheme();
applyAccent();
initReminder();
document.getElementById('version-label').textContent = VERSION;

window.addEventListener('beforeunload', flushDirty);

function showApp() {
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

        if (unsubscribe) unsubscribe();
        unsubscribe = subscribeTodos(user.uid, (todos) => {
            scheduleRender(todos);
        });

        try { await moveTodos(user.uid); } catch (e) { console.error('moveTodos:', e); }
        try { await cleanupNotes(user.uid); } catch (e) { console.error('cleanupNotes:', e); }

        if (saveInterval) clearInterval(saveInterval);
        saveInterval = setInterval(flushDirty, 60000);

        // Re-run moveTodos when app comes back into focus (e.g. from background on mobile)
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && currentUid) {
                moveTodos(currentUid).catch(e => console.error('moveTodos:', e));
                cleanupNotes(currentUid).catch(e => console.error('cleanupNotes:', e));
            }
        });
    },
    () => {
        currentUid = null;
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        if (saveInterval) { clearInterval(saveInterval); saveInterval = null; }
        showAuth();
    }
);
