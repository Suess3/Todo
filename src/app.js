import { initAuth, renderAuthScreen, signOutUser } from './auth.js';
import { moveTodos, subscribeTodos } from './todoService.js';
import { scheduleRender } from './render.js';

let unsubscribe = null;
let currentUid = null;

function showApp() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
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

        try { await moveTodos(user.uid); } catch (e) { console.error('moveTodos:', e); }

        if (unsubscribe) unsubscribe();
        unsubscribe = subscribeTodos(user.uid, (todos) => {
            scheduleRender(todos);
        });
    },
    () => {
        currentUid = null;
        if (unsubscribe) {
            unsubscribe();
            unsubscribe = null;
        }
        showAuth();
    }
);
