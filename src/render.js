import { auth } from './firebase.js';
import { getTodayEpoch, addTodo, toggleTodo, updateTodoText, deleteTodo } from './todoService.js';

const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const expandedStates = {};
const dirtyIds = new Set(); // todo IDs with unsaved text changes

let currentTodos = [];
let focusTarget = null; // { id, cursor } to restore after render
let currentPage = 'todo';

export function setPage(page) {
    currentPage = page;
    renderApp(currentTodos);
}

// Save all dirty todos to Firestore
export async function flushDirty() {
    const uid = auth.currentUser?.uid;
    if (!uid || dirtyIds.size === 0) return;
    const ids = [...dirtyIds];
    dirtyIds.clear();
    for (const id of ids) {
        const todo = currentTodos.find(t => t.id === id);
        if (todo) await updateTodoText(uid, id, todo.text);
    }
}

export function scheduleRender(todos) {
    // Preserve any unsaved local text edits — don't let Firestore overwrite them
    currentTodos = todos.map(t => {
        if (dirtyIds.has(t.id)) {
            const local = currentTodos.find(l => l.id === t.id);
            return local || t;
        }
        return t;
    });
    renderApp(currentTodos);
}

function formatDate(epoch) {
    const d = new Date(epoch * 86400000);
    return d.getDate().toString().padStart(2, '0') + '. ' + MONTH_NAMES[d.getMonth()];
}

function getDayName(epoch) {
    return DAY_NAMES[new Date(epoch * 86400000).getDay()];
}

export function renderApp(todos) {
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    // Save focused input state before wiping the DOM
    const active = document.activeElement;
    const savedFocus = (active && active.dataset.id) ? {
        id: active.dataset.id,
        start: active.selectionStart,
        end: active.selectionEnd
    } : null;

    const container = document.getElementById('app-content');
    container.innerHTML = '';

    if (currentPage === 'todo') {
        const today = getTodayEpoch();
        for (let i = -1; i <= 6; i++) {
            renderDaySection(container, today + i, today, todos, uid);
        }
    } else {
        renderFlatSection(container, todos, uid);
    }

    // Restore focus
    if (focusTarget) {
        const el = container.querySelector(`[data-id="${focusTarget.id}"]`);
        if (el) { el.focus(); el.setSelectionRange(focusTarget.cursor, focusTarget.cursor); }
        focusTarget = null;
    } else if (savedFocus) {
        const el = container.querySelector(`[data-id="${savedFocus.id}"]`);
        if (el) { el.focus(); el.setSelectionRange(savedFocus.start, savedFocus.end); }
    }
}

function renderDaySection(container, dateEpoch, today, allTodos, uid) {
    const isToday = dateEpoch === today;
    const isPast = dateEpoch < today;
    const dayTodos = allTodos.filter(t => t.dateEpochDay === dateEpoch && (!t.page || t.page === 'todo'));

    if (expandedStates[dateEpoch] === undefined) {
        expandedStates[dateEpoch] = !isPast;
    }
    const isOpen = expandedStates[dateEpoch];

    const section = document.createElement('div');
    section.className = 'day-section';

    // Header
    const header = document.createElement('div');
    header.className = 'day-header';
    header.innerHTML = `
        <span class="weekday ${isToday ? 'today' : ''}">${getDayName(dateEpoch)}</span>
        <span class="date-small">${formatDate(dateEpoch)}</span>
        <span class="toggle-icon ${isOpen ? '' : 'closed'}">▼</span>
    `;
    header.addEventListener('click', () => {
        expandedStates[dateEpoch] = !expandedStates[dateEpoch];
        renderApp(currentTodos);
    });
    section.appendChild(header);

    // List
    const list = document.createElement('div');
    list.className = `todo-list${isOpen ? '' : ' hidden'}`;

    dayTodos.forEach(todo => {
        const row = document.createElement('div');
        row.className = `todo-row${todo.isDone ? ' done' : ''}`;

        let textColor = 'var(--text)';
        if (todo.isDone || isPast) {
            textColor = 'var(--text-muted)';
        } else if (todo.moveCount === 1) {
            textColor = '#FFD700';
        } else if (todo.moveCount === 2) {
            textColor = '#FFA040';
        } else if (todo.moveCount >= 3) {
            textColor = '#FF6B6B';
        }

        // Checkbox
        const checkWrapper = document.createElement('div');
        checkWrapper.className = 'checkbox-wrapper';
        const checkbox = document.createElement('div');
        checkbox.className = ['checkbox', todo.isDone ? 'checked' : '', isToday && !todo.isDone ? 'today-unchecked' : ''].join(' ').trim();
        checkbox.textContent = todo.isDone ? '✓' : '';
        checkWrapper.appendChild(checkbox);
        checkWrapper.addEventListener('click', () => toggleTodo(uid, todo.id, !todo.isDone));

        // Input
        const input = document.createElement('input');
        input.type = 'text';
        input.dataset.id = todo.id;
        input.className = `todo-input${todo.isDone ? ' done' : ''}`;
        input.value = todo.text;
        input.style.color = textColor;

        // Typing: update local state only, mark dirty for periodic save
        input.addEventListener('input', () => {
            const idx = currentTodos.findIndex(t => t.id === todo.id);
            currentTodos[idx] = { ...currentTodos[idx], text: input.value };
            dirtyIds.add(todo.id);
        });

        // Bug 6: save on blur so changes aren't lost when clicking away
        input.addEventListener('blur', () => {
            const uid2 = auth.currentUser?.uid;
            if (!uid2 || !dirtyIds.has(todo.id)) return;
            dirtyIds.delete(todo.id);
            const current = currentTodos.find(t => t.id === todo.id);
            if (current) updateTodoText(uid2, todo.id, current.text);
        });

        let enterInFlight = false; // Bug 1: guard against double Enter
        input.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (enterInFlight) return; // Bug 1: ignore rapid second press
                enterInFlight = true;

                const cursor = input.selectionStart;
                const before = input.value.slice(0, cursor);
                const after = input.value.slice(cursor);
                const idx = currentTodos.findIndex(t => t.id === todo.id);

                // Bug 2: insert new todo right after current, not at the end
                const next = currentTodos.find(
                    (t, i) => i > idx && t.dateEpochDay === dateEpoch
                );
                const currentOrder = currentTodos[idx].sortOrder;
                const nextOrder = next ? next.sortOrder : currentOrder + 2000;
                const newSortOrder = (currentOrder + nextOrder) / 2;

                currentTodos[idx] = { ...currentTodos[idx], text: before };
                dirtyIds.add(todo.id);

                // Bug 4: set focusTarget and render locally before the async write
                const tempId = '_pending_' + Date.now();
                const tempTodo = {
                    id: tempId,
                    text: after,
                    isDone: false,
                    dateEpochDay: dateEpoch,
                    sortOrder: newSortOrder,
                    moveCount: 0,
                };
                currentTodos = [
                    ...currentTodos.slice(0, idx + 1),
                    tempTodo,
                    ...currentTodos.slice(idx + 1),
                ];
                focusTarget = { id: tempId, cursor: 0 };
                renderApp(currentTodos);

                const newDoc = await addTodo(uid, dateEpoch, after, newSortOrder);

                // Replace temp entry with real Firestore id
                currentTodos = currentTodos.map(t =>
                    t.id === tempId ? { ...t, id: newDoc.id } : t
                );
                focusTarget = { id: newDoc.id, cursor: 0 };
                renderApp(currentTodos);

                enterInFlight = false;
            }

            // Bug 3: Backspace at start of non-empty line — merge with previous line
            if (e.key === 'Backspace' && input.selectionStart === 0 && input.selectionEnd === 0) {
                e.preventDefault();
                const idx = currentTodos.findIndex(t => t.id === todo.id);
                const prev = currentTodos.slice(0, idx).reverse().find(t => t.dateEpochDay === dateEpoch);
                if (!prev && input.value === '') {
                    // Empty first line of day — just delete it
                    currentTodos = currentTodos.filter(t => t.id !== todo.id);
                    dirtyIds.delete(todo.id);
                    renderApp(currentTodos);
                    deleteTodo(uid, todo.id);
                    return;
                }
                if (!prev) return; // nothing above on this day

                if (input.value === '') {
                    // Empty line: delete and move focus up
                    focusTarget = { id: prev.id, cursor: prev.text.length };
                    currentTodos = currentTodos.filter(t => t.id !== todo.id);
                    dirtyIds.delete(todo.id);
                    renderApp(currentTodos);
                    deleteTodo(uid, todo.id);
                } else {
                    // Non-empty line: merge text onto previous line
                    const mergedText = prev.text + input.value;
                    const splitCursor = prev.text.length;
                    const prevIdx = currentTodos.findIndex(t => t.id === prev.id);
                    currentTodos[prevIdx] = { ...currentTodos[prevIdx], text: mergedText };
                    dirtyIds.add(prev.id);
                    currentTodos = currentTodos.filter(t => t.id !== todo.id);
                    dirtyIds.delete(todo.id);
                    focusTarget = { id: prev.id, cursor: splitCursor };
                    renderApp(currentTodos);
                    deleteTodo(uid, todo.id);
                }
            }

            // Bug 5: arrow keys — move focus directly, no re-render needed
            if (e.key === 'ArrowUp' && input.selectionStart === 0) {
                e.preventDefault();
                const idx = currentTodos.findIndex(t => t.id === todo.id);
                const prev = currentTodos.slice(0, idx).reverse().find(t => t.dateEpochDay === dateEpoch);
                if (prev) {
                    const el = document.querySelector(`[data-id="${prev.id}"]`);
                    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
                }
            }

            if (e.key === 'ArrowDown' && input.selectionStart === input.value.length) {
                e.preventDefault();
                const idx = currentTodos.findIndex(t => t.id === todo.id);
                const next = currentTodos.slice(idx + 1).find(t => t.dateEpochDay === dateEpoch);
                if (next) {
                    const el = document.querySelector(`[data-id="${next.id}"]`);
                    if (el) { el.focus(); el.setSelectionRange(0, 0); }
                }
            }
        });

        row.appendChild(checkWrapper);
        row.appendChild(input);
        list.appendChild(row);
    });

    // Tap to add
    if (isOpen) {
        const addBtn = document.createElement('div');
        addBtn.className = 'tap-to-add';
        if (dayTodos.length === 0) addBtn.textContent = 'No tasks (tap to add)';
        addBtn.addEventListener('click', () => addTodo(uid, dateEpoch));
        list.appendChild(addBtn);
    }

    section.appendChild(list);
    container.appendChild(section);
}

function renderFlatSection(container, allTodos, uid) {
    const pageTodos = allTodos.filter(t => t.page === currentPage);

    const list = document.createElement('div');
    list.className = 'todo-list flat-list';

    pageTodos.forEach(todo => {
        const row = document.createElement('div');
        row.className = `todo-row${todo.isDone ? ' done' : ''}`;

        const checkWrapper = document.createElement('div');
        checkWrapper.className = 'checkbox-wrapper';
        const checkbox = document.createElement('div');
        checkbox.className = ['checkbox', todo.isDone ? 'checked' : ''].join(' ').trim();
        checkbox.textContent = todo.isDone ? '✓' : '';
        checkWrapper.appendChild(checkbox);
        checkWrapper.addEventListener('click', () => toggleTodo(uid, todo.id, !todo.isDone));

        const input = document.createElement('input');
        input.type = 'text';
        input.dataset.id = todo.id;
        input.className = `todo-input${todo.isDone ? ' done' : ''}`;
        input.value = todo.text;

        input.addEventListener('input', () => {
            const idx = currentTodos.findIndex(t => t.id === todo.id);
            currentTodos[idx] = { ...currentTodos[idx], text: input.value };
            dirtyIds.add(todo.id);
        });

        input.addEventListener('blur', () => {
            const uid2 = auth.currentUser?.uid;
            if (!uid2 || !dirtyIds.has(todo.id)) return;
            dirtyIds.delete(todo.id);
            const current = currentTodos.find(t => t.id === todo.id);
            if (current) updateTodoText(uid2, todo.id, current.text);
        });

        const siblings = () => currentTodos.filter(t => t.page === currentPage);

        let enterInFlight = false;
        input.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (enterInFlight) return;
                enterInFlight = true;

                const cursor = input.selectionStart;
                const before = input.value.slice(0, cursor);
                const after = input.value.slice(cursor);
                const idx = currentTodos.findIndex(t => t.id === todo.id);
                const sibs = siblings();
                const sibIdx = sibs.findIndex(t => t.id === todo.id);
                const nextSib = sibs[sibIdx + 1];
                const currentOrder = currentTodos[idx].sortOrder;
                const nextOrder = nextSib ? nextSib.sortOrder : currentOrder + 2000;
                const newSortOrder = (currentOrder + nextOrder) / 2;

                currentTodos[idx] = { ...currentTodos[idx], text: before };
                dirtyIds.add(todo.id);

                const tempId = '_pending_' + Date.now();
                const tempTodo = {
                    id: tempId, text: after, isDone: false,
                    dateEpochDay: 0, sortOrder: newSortOrder, moveCount: 0, page: currentPage,
                };
                currentTodos = [
                    ...currentTodos.slice(0, idx + 1),
                    tempTodo,
                    ...currentTodos.slice(idx + 1),
                ];
                focusTarget = { id: tempId, cursor: 0 };
                renderApp(currentTodos);

                const newDoc = await addTodo(uid, 0, after, newSortOrder, currentPage);
                currentTodos = currentTodos.map(t => t.id === tempId ? { ...t, id: newDoc.id } : t);
                focusTarget = { id: newDoc.id, cursor: 0 };
                renderApp(currentTodos);
                enterInFlight = false;
            }

            if (e.key === 'Backspace' && input.selectionStart === 0 && input.selectionEnd === 0) {
                e.preventDefault();
                const sibs = siblings();
                const sibIdx = sibs.findIndex(t => t.id === todo.id);
                const prev = sibs[sibIdx - 1];

                if (!prev && input.value === '') {
                    currentTodos = currentTodos.filter(t => t.id !== todo.id);
                    dirtyIds.delete(todo.id);
                    renderApp(currentTodos);
                    deleteTodo(uid, todo.id);
                    return;
                }
                if (!prev) return;

                if (input.value === '') {
                    focusTarget = { id: prev.id, cursor: prev.text.length };
                    currentTodos = currentTodos.filter(t => t.id !== todo.id);
                    dirtyIds.delete(todo.id);
                    renderApp(currentTodos);
                    deleteTodo(uid, todo.id);
                } else {
                    const mergedText = prev.text + input.value;
                    const splitCursor = prev.text.length;
                    const prevIdx = currentTodos.findIndex(t => t.id === prev.id);
                    currentTodos[prevIdx] = { ...currentTodos[prevIdx], text: mergedText };
                    dirtyIds.add(prev.id);
                    currentTodos = currentTodos.filter(t => t.id !== todo.id);
                    dirtyIds.delete(todo.id);
                    focusTarget = { id: prev.id, cursor: splitCursor };
                    renderApp(currentTodos);
                    deleteTodo(uid, todo.id);
                }
            }

            if (e.key === 'ArrowUp' && input.selectionStart === 0) {
                e.preventDefault();
                const sibs = siblings();
                const prev = sibs[sibs.findIndex(t => t.id === todo.id) - 1];
                if (prev) {
                    const el = document.querySelector(`[data-id="${prev.id}"]`);
                    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
                }
            }

            if (e.key === 'ArrowDown' && input.selectionStart === input.value.length) {
                e.preventDefault();
                const sibs = siblings();
                const next = sibs[sibs.findIndex(t => t.id === todo.id) + 1];
                if (next) {
                    const el = document.querySelector(`[data-id="${next.id}"]`);
                    if (el) { el.focus(); el.setSelectionRange(0, 0); }
                }
            }
        });

        row.appendChild(checkWrapper);
        row.appendChild(input);
        list.appendChild(row);
    });

    const addBtn = document.createElement('div');
    addBtn.className = 'tap-to-add';
    if (pageTodos.length === 0) addBtn.textContent = 'No items (tap to add)';
    addBtn.addEventListener('click', () => addTodo(uid, 0, '', Date.now(), currentPage));
    list.appendChild(addBtn);

    container.appendChild(list);
}
