import { initAuth, renderAuthScreen, signOutUser } from './auth.js';
import { moveTodos, subscribeTodos } from './todoService.js';
import { scheduleRender } from './render.js';

let unsubscribe = null;

initAuth(
    async (user) => {
        document.getElementById('auth-screen').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');

        // Move all unchecked past todos to today (runs once on load/refresh)
        await moveTodos(user.uid);

        // Subscribe to live Firestore updates
        unsubscribe = subscribeTodos(user.uid, (todos) => {
            scheduleRender(todos);
        });

        document.getElementById('signout-btn').addEventListener('click', signOutUser);
    },
    () => {
        if (unsubscribe) {
            unsubscribe();
            unsubscribe = null;
        }
        document.getElementById('app').classList.add('hidden');
        renderAuthScreen();
    }
);
