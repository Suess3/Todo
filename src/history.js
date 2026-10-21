// Undo/redo stacks for structural changes: deleting rows, splitting and merging
// them, reordering, moving to another day and checking a box. Typing inside a row
// is deliberately not on these stacks — the browser's own undo already handles
// text in a focused field, and taking Cmd+Z away from it would be a downgrade.
//
// Every entry is a function that applies one change and returns the entry that
// reverts it again — undo hands that to the redo stack and vice versa. The one
// thing a revert cannot restore is a Firestore id: deleting a row deletes its
// document, so a restored row comes back under a new id. Anything that pointed at
// the old id (a Notes child's parentId, a queued text restore) is remapped
// through idMap, and the returned inverse already works on the new ids.

import { auth } from './firebase.js';
import { restoreTodo, setParent, updateTodoText, updateSortOrder, toggleTodo, recordProductivity, deleteTodo, moveTodoToDay } from './todoService.js';
import { todos, setTodos, dirtyIds, rerender } from './store.js';
import { showToast } from './feedback.js';
import { t } from './i18n.js';

const LIMIT = 50;
const undoStack = [];
const redoStack = [];
let busy = false;

function pushHistory(entry) {
    undoStack.push(entry);
    if (undoStack.length > LIMIT) undoStack.shift();
    // A new change branches off — whatever was undone before can't be redone onto it
    redoStack.length = 0;
    updateUndoButton();
}

export function clearHistory() {
    undoStack.length = 0;
    redoStack.length = 0;
    updateUndoButton();
}

async function replay(from, to) {
    if (busy) return;
    const entry = from.pop();
    updateUndoButton();
    if (!entry) return;
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    busy = true;
    try {
        const inverse = await entry(uid);
        if (inverse) {
            to.push(inverse);
            if (to.length > LIMIT) to.shift();
        }
    } catch (e) {
        showToast(t('undo_failed'), 'error');
        console.error(e);
    } finally {
        busy = false;
        updateUndoButton();
    }
}

export const undo = () => replay(undoStack, redoStack);
export const redo = () => replay(redoStack, undoStack);

// --- Recorders (called right after the change they invert) ---

// The one primitive behind delete, merge and split.
//   removed       full snapshots of rows to bring back, parents before children
//   reparented    { id, previousParentId } of surviving rows promoteChildren lifted
//   textRestores  { id, text } of rows whose text the change rewrote
//   created       ids of rows the change added, to be deleted again
export function recordChange({ removed = [], reparented = [], textRestores = [], created = [] }) {
    if (!removed.length && !reparented.length && !textRestores.length && !created.length) return;
    pushHistory(changeEntry({ removed: removed.map(row => ({ ...row })), reparented, textRestores, created }));
}

function changeEntry({ removed, reparented, textRestores, created }) {
    return async (uid) => {
        // Captured before anything is touched — this is what the inverse puts back
        const createdRows = created.map(id => todos.find(t => t.id === id)).filter(Boolean).map(row => ({ ...row }));
        const idMap = new Map();
        const restoredRows = [];

        // Parents first, so a child's restored parent already exists when it lands
        for (const row of removed) {
            const oldParent = row.parentId || null;
            const parentId = oldParent
                ? (idMap.get(oldParent) ?? (todos.some(t => t.id === oldParent) ? oldParent : null))
                : null;
            const doc = await restoreTodo(uid, { ...row, parentId });
            idMap.set(row.id, doc.id);
            restoredRows.push({ ...row, id: doc.id, parentId });
        }

        const reparentInverse = reparented.map(({ id }) => ({ id, previousParentId: todos.find(t => t.id === id)?.parentId ?? null }));
        await Promise.all([
            ...created.map(id => deleteTodo(uid, id).catch(e => console.error(e))),
            ...reparented.map(({ id, previousParentId }) => {
                const target = previousParentId ? (idMap.get(previousParentId) ?? previousParentId) : null;
                return setParent(uid, id, target).catch(e => console.error(e));
            }),
        ]);

        const textInverse = await restoreTexts(uid, textRestores.map(r => ({ ...r, id: idMap.get(r.id) ?? r.id })));

        return changeEntry({
            removed: createdRows,
            reparented: reparentInverse,
            textRestores: textInverse,
            created: restoredRows.map(r => r.id),
        });
    };
}

export function recordReorder(id, previousSortOrder) {
    pushHistory(reorderEntry(id, previousSortOrder));
}

function reorderEntry(id, sortOrder) {
    return async (uid) => {
        const idx = todos.findIndex(t => t.id === id);
        if (idx === -1) return null;
        const current = todos[idx].sortOrder;
        todos[idx] = { ...todos[idx], sortOrder };
        todos.sort((a, b) => a.sortOrder - b.sortOrder);
        dirtyIds.add(id);
        rerender(todos);
        try {
            await updateSortOrder(uid, id, sortOrder);
        } finally {
            dirtyIds.delete(id);
        }
        return reorderEntry(id, current);
    };
}

// Dragging a todo onto another day changes its date and its place in that day
export function recordDayMove(id, previousDay, previousSortOrder) {
    pushHistory(dayMoveEntry(id, previousDay, previousSortOrder));
}

function dayMoveEntry(id, day, sortOrder) {
    return async (uid) => {
        const idx = todos.findIndex(t => t.id === id);
        if (idx === -1) return null;
        const { dateEpochDay: currentDay, sortOrder: currentOrder } = todos[idx];
        todos[idx] = { ...todos[idx], dateEpochDay: day, sortOrder };
        todos.sort((a, b) => a.sortOrder - b.sortOrder);
        dirtyIds.add(id);
        rerender(todos);
        try {
            await moveTodoToDay(uid, id, day, sortOrder);
        } finally {
            dirtyIds.delete(id);
        }
        return dayMoveEntry(id, currentDay, currentOrder);
    };
}

// countedProductivity: checking a box on the todo page bumps the daily counter,
// so undoing it has to bump the same bucket back down (and redo up again)
export function recordToggle(id, previousIsDone, moveCount, countedProductivity) {
    pushHistory(toggleEntry(id, previousIsDone, moveCount, countedProductivity ? -1 : 0));
}

function toggleEntry(id, isDone, moveCount, productivityDelta) {
    return async (uid) => {
        if (!todos.some(t => t.id === id)) return null;
        await toggleTodo(uid, id, isDone);
        if (productivityDelta) {
            await recordProductivity(uid, moveCount, productivityDelta).catch(e => console.error(e));
        }
        return toggleEntry(id, !isDone, moveCount, -productivityDelta);
    };
}

// --- Helpers ---

// Writes the old text back into state and Firestore, and returns the texts it
// replaced (for the inverse entry). The focused row is blurred first: while an
// input has focus the reconcile deliberately leaves its value alone, so without
// this the restored text would never reach the DOM.
async function restoreTexts(uid, textRestores) {
    const pending = textRestores.filter(({ id }) => todos.some(t => t.id === id));
    if (pending.length === 0) return [];

    const replaced = pending.map(({ id, text }) => {
        const idx = todos.findIndex(t => t.id === id);
        const previous = todos[idx].text;
        todos[idx] = { ...todos[idx], text };
        dirtyIds.delete(id);
        return { id, text: previous };
    });
    if (document.activeElement?.classList.contains('todo-input')) document.activeElement.blur();
    rerender(todos);

    await Promise.all(pending.map(({ id, text }) =>
        updateTodoText(uid, id, text).catch(e => console.error(e))));
    return replaced;
}

function updateUndoButton() {
    const btn = document.getElementById('undo-btn');
    if (!btn) return;
    btn.disabled = undoStack.length === 0;
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
        if (!(e.metaKey || e.ctrlKey)) return;
        const key = e.key.toLowerCase();
        // Cmd/Ctrl+Shift+Z everywhere, plus Windows' Ctrl+Y
        const isRedo = (key === 'z' && e.shiftKey) || (key === 'y' && e.ctrlKey && !e.metaKey && !e.shiftKey);
        const isUndo = key === 'z' && !e.shiftKey;
        if (!isUndo && !isRedo) return;
        // Inside a focused row the browser's own text undo/redo is the better tool
        if (document.activeElement?.classList.contains('todo-input')) return;
        e.preventDefault();
        isRedo ? redo() : undo();
    });
    updateUndoButton();
}
