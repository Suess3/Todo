import { auth } from './firebase.js';
import { updateTodoText } from './todoService.js';
import { todos, setTodos, dirtyIds, rerender } from './store.js';
import { updateSaveStatus, showToast } from './feedback.js';

const saveTimers = new Map();

// Writes one dirty todo's text; returns false only on a failed write.
// The id is removed from dirtyIds optimistically and re-added on failure.
async function writeTodoText(uid, id) {
    if (!dirtyIds.has(id)) return true;
    const todo = todos.find(t => t.id === id);
    if (!todo) return true;
    dirtyIds.delete(id);
    try {
        await updateTodoText(uid, id, todo.text);
        return true;
    } catch (e) {
        dirtyIds.add(id);
        console.error(e);
        return false;
    }
}

export async function saveTodoText(id) {
    if (id.startsWith('_pending_')) return;
    const uid = auth.currentUser?.uid;
    if (!uid || !dirtyIds.has(id)) return;
    updateSaveStatus('saving');
    const ok = await writeTodoText(uid, id);
    updateSaveStatus(ok ? 'idle' : 'error');
    if (!ok) showToast('Failed to save changes', 'error');
}

// 2s debounce after typing. The id is re-read from the input when the timer
// fires — it may have been swapped from a temp to a real id in the meantime.
export function scheduleSave(id, inputEl) {
    clearTimeout(saveTimers.get(id));
    saveTimers.set(id, setTimeout(() => {
        saveTimers.delete(id);
        saveTodoText(inputEl.dataset.id);
    }, 2000));
}

export function attachBlurSave(input) {
    input.addEventListener('blur', () => {
        const id = input.dataset.id;
        clearTimeout(saveTimers.get(id));
        saveTimers.delete(id);
        saveTodoText(id);
    });
}

export async function flushDirty() {
    const uid = auth.currentUser?.uid;
    if (!uid || dirtyIds.size === 0) return;
    const ids = [...dirtyIds].filter(id => !id.startsWith('_pending_'));
    if (ids.length === 0) return;
    updateSaveStatus('saving');
    const results = await Promise.all(ids.map(id => writeTodoText(uid, id)));
    const ok = results.every(Boolean);
    updateSaveStatus(ok ? 'idle' : 'error');
    if (!ok) showToast('Sync failed', 'error');
}

// Enter-created rows exist locally under a temp id first, so focus can land
// without waiting for Firestore. This persists them and swaps the temp id for
// the real one in state and DOM — deliberately without a full re-render, which
// would close the mobile keyboard. Returns the new doc, or null after rolling
// the temp row back on a failed write.
export async function commitTempTodo(tempId, createPromise, errorMessage = 'Failed to create todo') {
    try {
        updateSaveStatus('saving');
        const newDoc = await createPromise;
        updateSaveStatus('idle');
        setTodos(todos.map(t => t.id === tempId ? { ...t, id: newDoc.id } : t));
        if (dirtyIds.has(tempId)) { dirtyIds.delete(tempId); dirtyIds.add(newDoc.id); }
        document.querySelectorAll(`[data-id="${tempId}"]`).forEach(el => { el.dataset.id = newDoc.id; });
        return newDoc;
    } catch (e) {
        updateSaveStatus('error');
        showToast(errorMessage, 'error');
        setTodos(todos.filter(t => t.id !== tempId));
        rerender(todos);
        console.error(e);
        return null;
    }
}
