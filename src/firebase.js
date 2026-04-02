import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyDULojwaebqfM9f1z7L4JFiUO0eqK9OpBQ",
    authDomain: "todo-28d2e.firebaseapp.com",
    projectId: "todo-28d2e",
    storageBucket: "todo-28d2e.firebasestorage.app",
    messagingSenderId: "640913241762",
    appId: "1:640913241762:web:cdb26cd9a79d061cb609fb"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
