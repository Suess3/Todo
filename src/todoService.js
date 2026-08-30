import { db } from './firebase.js';
import {
    collection, addDoc, onSnapshot, query, orderBy,
    updateDoc, doc, deleteDoc, where, getDocs, writeBatch,
    setDoc, increment
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export function getTodayEpoch() {
    const now = new Date();
    return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000);
}

function todosRef(uid) {
    return collection(db, 'users', uid, 'todos');
}

// Runs once on load: moves all unchecked past todos to today and increments moveCount.
// Uses a batch update (never creates new documents) to prevent duplication.
export async function moveTodos(uid) {
    const today = getTodayEpoch();
    const q = query(todosRef(uid), where('isDone', '==', false));
    const snapshot = await getDocs(q);
    const toMove = snapshot.docs.filter(d => {
        const data = d.data();
        const isTodoPage = !data.page || data.page === 'todo';
        return isTodoPage && data.dateEpochDay < today;
    });
    if (toMove.length === 0) return;

    const batch = writeBatch(db);
    toMove.forEach(docSnap => {
        batch.update(docSnap.ref, {
            dateEpochDay: today,
            // increment() instead of read+1: two devices doing the morning move
            // concurrently would otherwise both write the same stale count
            moveCount: increment(1)
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

export async function addTodo(uid, dateEpoch, text = '', sortOrder = Date.now(), page = 'todo', parentId = null) {
    return addDoc(todosRef(uid), {
        text,
        isDone: false,
        dateEpochDay: dateEpoch,
        sortOrder,
        moveCount: 0,
        page,
        parentId,
        isToggle: false,
        collapsed: false,
        createdAt: Date.now(),
    });
}

// Re-creates a deleted todo for undo. The original document is gone, so this
// hands back a new id — callers remap anything that pointed at the old one.
export async function restoreTodo(uid, data) {
    return addDoc(todosRef(uid), {
        text: data.text ?? '',
        isDone: !!data.isDone,
        dateEpochDay: data.dateEpochDay ?? 0,
        sortOrder: data.sortOrder ?? Date.now(),
        moveCount: data.moveCount ?? 0,
        page: data.page ?? 'todo',
        parentId: data.parentId ?? null,
        isToggle: !!data.isToggle,
        collapsed: !!data.collapsed,
        createdAt: data.createdAt ?? Date.now(),
        completedAt: data.completedAt ?? null,
    });
}

export async function toggleTodo(uid, id, newState) {
    return updateDoc(doc(db, 'users', uid, 'todos', id), {
        isDone: newState,
        completedAt: newState ? Date.now() : null,
    });
}

export async function cleanupNotes(uid) {
    const oneDayAgo = Date.now() - 86400000;
    const batch = writeBatch(db);

    for (const page of ['keepInMind', 'soon']) {
        const q = query(todosRef(uid), where('page', '==', page), where('isDone', '==', true));
        const snapshot = await getDocs(q);
        snapshot.docs.forEach(d => {
            const { completedAt } = d.data();
            if (completedAt && completedAt < oneDayAgo) {
                batch.delete(d.ref);
            }
        });
    }

    await batch.commit();
}

export async function updateTodoText(uid, id, text) {
    return updateDoc(doc(db, 'users', uid, 'todos', id), { text });
}

export async function updateSortOrder(uid, id, sortOrder) {
    return updateDoc(doc(db, 'users', uid, 'todos', id), { sortOrder });
}

export async function deleteTodo(uid, id) {
    return deleteDoc(doc(db, 'users', uid, 'todos', id));
}

export async function setIsToggle(uid, id, isToggle) {
    return updateDoc(doc(db, 'users', uid, 'todos', id), { isToggle });
}

export async function setCollapsed(uid, id, collapsed) {
    return updateDoc(doc(db, 'users', uid, 'todos', id), { collapsed });
}

export async function setParent(uid, id, parentId) {
    return updateDoc(doc(db, 'users', uid, 'todos', id), { parentId });
}

function localDayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Records a todo completion into the daily productivity summary.
// Uses Firestore increment so concurrent writes from multiple devices don't conflict.
// delta is -1 when undo takes a completion back off the counter
export async function recordProductivity(uid, moveCount, delta = 1) {
    const bucket = String(Math.min(moveCount || 0, 5));
    const ref = doc(db, 'users', uid, 'productivity', localDayKey());
    await setDoc(ref, { [bucket]: increment(delta) }, { merge: true });
}
