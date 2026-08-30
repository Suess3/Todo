// Undo stack for structural changes: deleting rows, splitting and merging them,
// reordering and checking a box. Typing inside a row is deliberately not on this
// stack — the browser's own undo already handles text in a focused field, and
// taking Cmd+Z away from it would be a downgrade.
//
// Every entry knows how to invert itself. The one thing undo cannot restore is a
// Firestore id: deleting a row deletes its document, so a restored row comes back
// under a new id. Anything that pointed at the old id (a Notes child's parentId,
// a queued text restore) is remapped through idMap while the entry replays.

import { auth } from './firebase.js';
import { restoreTodo, setParent, updateTodoText, updateSortOrder, toggleTodo, recordProductivity, deleteTodo } from './todoService.js';
import { todos, setTodos, dirtyIds, rerender } from './store.js';
import { showToast } from './feedback.js';
import { t } from './i18n.js';

const LIMIT = 50;
const stack = [];
let undoing = false;

function pushHistory(undoFn) {
    stack.push(undoFn);
    if (stack.length > LIMIT) stack.shift();
    updateUndoButton();
}

export function clearHistory() {
    stack.length = 0;
    updateUndoButton();
}

export async function undo() {
    if (undoing) return;
    const entry = stack.pop();
    updateUndoButton();
    if (!entry) return;
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    undoing = true;
    try {
        await entry(uid);
    } catch (e) {
        showToast(t('undo_failed'), 'error');
        console.error(e);
    } finally {
        undoing = false;
    }
}

// --- Recorders (called right after the change they invert) ---

// The one primitive behind delete, merge and split.
//   removed       full snapshots of rows to bring back, parents before children
//   reparented    { id, previousParentId } of surviving rows promoteChildren lifted
//   textRestores  { id, text } of rows whose text the change rewrote
//   created       ids of rows the change added, to be deleted again
export function recordChange({ removed = [], reparented = [], textRestores = [], created = [] }) {
    if (!removed.length && !reparented.length && !textRestores.length && !created.length) return;
    const snapshot = removed.map(row => ({ ...row }));
    pushHistory(async (uid) => {
        const idMap = new Map();

        // Parents first, so a child's restored parent already exists when it lands
        for (const row of snapshot) {
            const oldParent = row.parentId || null;
            const parentId = oldParent
                ? (idMap.get(oldParent) ?? (todos.some(t => t.id === oldParent) ? oldParent : null))
                : null;
            const doc = await restoreTodo(uid, { ...row, parentId });
            idMap.set(row.id, doc.id);
        }

        await Promise.all([
            ...created.map(id => deleteTodo(uid, id).catch(e => console.error(e))),
            ...reparented.map(({ id, previousParentId }) => {
                const target = previousParentId ? (idMap.get(previousParentId) ?? previousParentId) : null;
                return setParent(uid, id, target).catch(e => console.error(e));
            }),
        ]);

        await restoreTexts(uid, textRestores.map(r => ({ ...r, id: idMap.get(r.id) ?? r.id })));
    });
}

export function recordReorder(id, previousSortOrder) {
    pushHistory(async (uid) => {
        const idx = todos.findIndex(t => t.id === id);
        if (idx === -1) return;
        todos[idx] = { ...todos[idx], sortOrder: previousSortOrder };
        todos.sort((a, b) => a.sortOrder - b.sortOrder);
        dirtyIds.add(id);
        rerender(todos);
        try {
            await updateSortOrder(uid, id, previousSortOrder);
        } finally {
            dirtyIds.delete(id);
        }
    });
}

// countedProductivity: checking a box on the todo page bumps the daily counter,
// so undoing it has to bump the same bucket back down
export function recordToggle(id, previousIsDone, moveCount, countedProductivity) {
    pushHistory(async (uid) => {
        if (!todos.some(t => t.id === id)) return;
        await toggleTodo(uid, id, previousIsDone);
        if (countedProductivity) {
            await recordProductivity(uid, moveCount, -1).catch(e => console.error(e));
        }
    });
}

// --- Helpers ---

// Writes the old text back into state and Firestore. The focused row is blurred
// first: while an input has focus the reconcile deliberately leaves its value
// alone, so without this the restored text would never reach the DOM.
function restoreTexts(uid, textRestores) {
    const pending = textRestores.filter(({ id }) => todos.some(t => t.id === id));
    if (pending.length === 0) return;

    pending.forEach(({ id, text }) => {
        const idx = todos.findIndex(t => t.id === id);
        todos[idx] = { ...todos[idx], text };
        dirtyIds.delete(id);
    });
    if (document.activeElement?.classList.contains('todo-input')) document.activeElement.blur();
    rerender(todos);

    return Promise.all(pending.map(({ id, text }) =>
        updateTodoText(uid, id, text).catch(e => console.error(e))));
}

function updateUndoButton() {
    const btn = document.getElementById('undo-btn');
    if (!btn) return;
    btn.disabled = stack.length === 0;
    btn.title = t('undo');
}

let historyInitialized = false;

// onSignIn runs again when a different account signs in — the listeners below are
// module-level and must not stack up
export function initHistory() {
    if (historyInitialized) { updateUndoButton(); return; }
    historyInitialized = true;
    document.getElementById('undo-btn')?.addEventListener('click', () => undo());
    document.addEventListener('lang-changed', updateUndoButton);
    document.addEventListener('keydown', (e) => {
        if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
        // Inside a focused row the browser's own text undo is the better tool
        if (document.activeElement?.classList.contains('todo-input')) return;
        e.preventDefault();
        undo();
    });
    updateUndoButton();
}
