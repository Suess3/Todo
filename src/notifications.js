import { db, auth } from './firebase.js';
import { doc, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const VAPID_PUBLIC_KEY = 'BG8D8MujEHImvLLJV2P5kwV028aU7zFd3gUrWFCAwR9u60ZzvmRvHTTxzkwhhMKD5hgIyoYjR5bUNhrFUS5xkhQ';

function urlBase64ToUint8Array(base64) {
    const pad = '='.repeat((4 - base64.length % 4) % 4);
    const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

export async function isNotificationSupported() {
    return 'Notification' in window && 'PushManager' in window;
}

export async function getNotificationStatus() {
    if (!await isNotificationSupported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub ? 'subscribed' : 'unsubscribed';
}

export async function subscribeToNotifications() {
    const uid = auth.currentUser?.uid;
    if (!uid) return false;

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return false;

    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });

    await setDoc(doc(db, 'users', uid, 'pushSubscription', 'main'), sub.toJSON());
    return true;
}

export async function unsubscribeFromNotifications() {
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();

    await deleteDoc(doc(db, 'users', uid, 'pushSubscription', 'main'));
}
