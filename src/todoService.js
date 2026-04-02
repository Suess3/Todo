import { db } from './firebase.js';
import {
    collection, addDoc, onSnapshot, query, orderBy,
    updateDoc, doc, deleteDoc, where, getDocs, writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export function getTodayEpoch() {
    return Math.floor(Date.now() / 86400000);
}

function todosRef(uid) {
    return collection(db, 'users', uid, 'todos');
}

// Runs once on load: moves all unchecked past todos to today and increments moveCount.
// Uses a batch update (never creates new documents) to prevent duplication.
export async function moveTodos(uid) {
    const today = getTodayEpoch();
    const q = query(
        todosRef(uid),
        where('dateEpochDay', '<', today),
        where('isDone', '==', false)
    );
    const snapshot = await getDocs(q);
    if (snapshot.empty) return;

    const batch = writeBatch(db);
    snapshot.forEach(docSnap => {
        batch.update(docSnap.ref, {
            dateEpochDay: today,
            moveCount: (docSnap.data().moveCount || 0) + 1
        });
    });
    await batch.commit();
}

export function subscribeTodos(uid, callback) {
    const q = query(todosRef(uid), orderBy('sortOrder', 'asc'));
    return onSnapshot(q, snapshot => {
        const todos = [];
        snapshot.forEach(d => todos.push({ id: d.id, ...d.data() }));
        callback(todos);
    });
}

export async function addTodo(uid, dateEpoch) {
    return addDoc(todosRef(uid), {
        text: '',
        isDone: false,
        dateEpochDay: dateEpoch,
        sortOrder: Date.now(),
        moveCount: 0
    });
}

export async function toggleTodo(uid, id, newState) {
    return updateDoc(doc(db, 'users', uid, 'todos', id), { isDone: newState });
}

export async function updateTodoText(uid, id, text) {
    return updateDoc(doc(db, 'users', uid, 'todos', id), { text });
}

export async function deleteTodo(uid, id) {
    return deleteDoc(doc(db, 'users', uid, 'todos', id));
}
