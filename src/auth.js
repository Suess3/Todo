import { auth } from './firebase.js';
import {
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

export function initAuth(onSignIn, onSignOut) {
    onAuthStateChanged(auth, user => {
        if (user) onSignIn(user);
        else onSignOut();
    });
}

export async function signOutUser() {
    return signOut(auth);
}

export function renderAuthScreen() {
    const screen = document.getElementById('auth-screen');
    screen.classList.remove('hidden');
    screen.innerHTML = `
        <div class="auth-container">
            <h1 class="auth-title">Todo</h1>
            <div class="auth-tabs">
                <button class="auth-tab active" id="tab-signin">Sign In</button>
                <button class="auth-tab" id="tab-signup">Sign Up</button>
            </div>
            <form id="auth-form">
                <input type="email" id="auth-email" placeholder="Email" required class="auth-input">
                <input type="password" id="auth-password" placeholder="Password" required class="auth-input">
                <p id="auth-error" class="auth-error hidden"></p>
                <button type="submit" id="auth-submit" class="auth-btn">Sign In</button>
            </form>
        </div>
    `;

    let mode = 'signin';

    document.getElementById('tab-signin').addEventListener('click', () => {
        mode = 'signin';
        document.getElementById('tab-signin').classList.add('active');
        document.getElementById('tab-signup').classList.remove('active');
        document.getElementById('auth-submit').textContent = 'Sign In';
        document.getElementById('auth-error').classList.add('hidden');
    });

    document.getElementById('tab-signup').addEventListener('click', () => {
        mode = 'signup';
        document.getElementById('tab-signup').classList.add('active');
        document.getElementById('tab-signin').classList.remove('active');
        document.getElementById('auth-submit').textContent = 'Sign Up';
        document.getElementById('auth-error').classList.add('hidden');
    });

    document.getElementById('auth-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('auth-email').value;
        const password = document.getElementById('auth-password').value;
        const errorEl = document.getElementById('auth-error');
        errorEl.classList.add('hidden');

        try {
            if (mode === 'signin') {
                await signInWithEmailAndPassword(auth, email, password);
            } else {
                await createUserWithEmailAndPassword(auth, email, password);
            }
        } catch (err) {
            errorEl.textContent = err.message;
            errorEl.classList.remove('hidden');
        }
    });
}
