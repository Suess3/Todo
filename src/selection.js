// Selecting across rows. Every row here is its own editing host — an <input>, a
// <textarea> or a contenteditable — and the browser locks a text selection into
// exactly one of them, so a drag that leaves its starting row simply stops at the
// edge. From that moment on we take over and mark whole rows instead: what is
// highlighted is precisely what Delete removes.
//
// Mouse only. On touch, press-and-drag already means reordering (dragdrop.js), so
// there is no free gesture left — see NOTES.md for the mobile idea.

import { auth } from './firebase.js';
import { deleteTodo } from './todoService.js';
import { todos, setTodos, dirtyIds, selectedIds, rerender } from './store.js';
import { showToast } from './feedback.js';
import { promoteChildren } from './notes.js';
import { recordChange } from './history.js';

function rowElements() {
    return [...document.querySelectorAll('#app-content .todo-row[data-id]')];
}

// Called after every render — reconciled rows are reused, so the class has to be
// re-applied rather than surviving on the element by itself.
export function applySelectionClasses() {
    if (selectedIds.size === 0) {
        document.querySelectorAll('.todo-row.row-selected').forEach(row => row.classList.remove('row-selected'));
        return;
    }
    rowElements().forEach(row => row.classList.toggle('row-selected', selectedIds.has(row.dataset.id)));
}

export function clearSelection() {
    if (selectedIds.size === 0) return;
    selectedIds.clear();
    applySelectionClasses();
}

// Selected rows in the order they are displayed
function orderedSelection() {
    const byId = new Map(todos.map(t => [t.id, t]));
    return rowElements()
        .filter(row => selectedIds.has(row.dataset.id))
        .map(row => byId.get(row.dataset.id))
        .filter(Boolean);
}

function markRange(anchorId, focusId) {
    const ids = rowElements().map(row => row.dataset.id);
    const a = ids.indexOf(anchorId);
    const b = ids.indexOf(focusId);
    if (a === -1 || b === -1) return;
    const [from, to] = a <= b ? [a, b] : [b, a];
    selectedIds.clear();
    for (let i = from; i <= to; i++) selectedIds.add(ids[i]);
    applySelectionClasses();
}

// Notes rows hold an HTML snippet — parse it in an inert <template>, never a live
// element, so nothing in it can load or fire while we read the text out
function plainText(html) {
    const tmpl = document.createElement('template');
    tmpl.innerHTML = html;
    return tmpl.content.textContent || '';
}

export async function deleteSelectedRows() {
    const uid = auth.currentUser?.uid;
    if (!uid || selectedIds.size === 0) return;

    // Display order matters: promoteChildren lifts a deleted row's children one
    // level up, so a parent has to be handled before its own children are.
    const doomed = orderedSelection().filter(t => !t.id.startsWith('_pending_'));
    if (doomed.length === 0) { clearSelection(); return; }

    const removed = doomed.map(t => ({ ...t }));
    const ids = new Set(doomed.map(t => t.id));
    const reparented = doomed
        .flatMap(t => promoteChildren(uid, t.id))
        .filter(({ id }) => !ids.has(id)); // a lifted child that is itself doomed needs no undo

    setTodos(todos.filter(t => !ids.has(t.id)));
    ids.forEach(id => dirtyIds.delete(id));
    clearSelection();
    rerender(todos);

    recordChange({ removed, reparented });

    const results = await Promise.allSettled([...ids].map(id => deleteTodo(uid, id)));
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length > 0) {
        showToast('Failed to delete', 'error');
        failed.forEach(r => console.error(r.reason));
    }
}

let selectionInitialized = false;

// Same reasoning as initHistory: only ever attach these once per page load
export function initSelection() {
    if (selectionInitialized) return;
    selectionInitialized = true;

    let anchorId = null;
    let active = false;

    document.addEventListener('pointerdown', (e) => {
        clearSelection();
        anchorId = null;
        active = false;
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        const row = e.target.closest?.('.todo-row[data-id]');
        // A drag off the ⋮⋮ handle is a reorder, not a selection
        if (!row || e.target.closest('.drag-handle')) return;
        anchorId = row.dataset.id;
    });

    document.addEventListener('pointermove', (e) => {
        if (!anchorId || e.buttons !== 1) return;
        const row = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.todo-row[data-id]');
        if (!row) return;
        // Inside the starting row the native text selection is exactly right — only
        // once the pointer crosses into another row do we take over
        if (!active && row.dataset.id === anchorId) return;
        if (!active) {
            active = true;
            document.body.classList.add('selecting-rows');
            document.activeElement?.blur?.();
        }
        window.getSelection()?.removeAllRanges();
        markRange(anchorId, row.dataset.id);
    });

    const endDrag = () => {
        anchorId = null;
        if (!active) return;
        active = false;
        document.body.classList.remove('selecting-rows');
    };
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);

    document.addEventListener('keydown', (e) => {
        if (selectedIds.size === 0) return;
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            deleteSelectedRows();
            return;
        }
        // Escape, or simply typing on, drops the marking like any text selection
        if (e.key === 'Escape' || (e.key.length === 1 && !e.metaKey && !e.ctrlKey)) clearSelection();
    });

    document.addEventListener('copy', (e) => {
        if (selectedIds.size === 0) return;
        e.clipboardData.setData('text/plain', orderedSelection().map(t => plainText(t.text)).join('\n'));
        e.preventDefault();
    });
}
