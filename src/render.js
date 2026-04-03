import { auth } from './firebase.js';
import { getTodayEpoch, addTodo, toggleTodo, updateTodoText, deleteTodo } from './todoService.js';

const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const expandedStates = {};
const debounceMap = new Map();

let currentTodos = [];
let focusTarget = null; // { id, cursor } to focus after next render

export function scheduleRender(todos) {
    currentTodos = todos;
    renderApp(todos);
}

function formatDate(epoch) {
    const d = new Date(epoch * 86400000);
    return d.getUTCDate().toString().padStart(2, '0') + '. ' + MONTH_NAMES[d.getUTCMonth()];
}

function getDayName(epoch) {
    return DAY_NAMES[new Date(epoch * 86400000).getUTCDay()];
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

    const today = getTodayEpoch();
    const container = document.getElementById('app-content');
    container.innerHTML = '';

    for (let i = -1; i <= 6; i++) {
        renderDaySection(container, today + i, today, todos, uid);
    }

    // Restore focus after render
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
    const dayTodos = allTodos.filter(t => t.dateEpochDay === dateEpoch);

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

        let textColor = 'white';
        if (todo.isDone || isPast) {
            textColor = 'gray';
        } else if (todo.moveCount === 1) {
            textColor = '#FFFFE6';
        } else if (todo.moveCount === 2) {
            textColor = '#FFEFE0';
        } else if (todo.moveCount >= 3) {
            textColor = '#FFEBEB';
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

        input.addEventListener('input', () => {
            const existing = debounceMap.get(todo.id);
            if (existing) clearTimeout(existing);
            debounceMap.set(todo.id, setTimeout(() => {
                updateTodoText(uid, todo.id, input.value);
                debounceMap.delete(todo.id);
            }, 500));
        });

        input.addEventListener('blur', () => {
            const existing = debounceMap.get(todo.id);
            if (existing) {
                clearTimeout(existing);
                debounceMap.delete(todo.id);
                updateTodoText(uid, todo.id, input.value);
            }
        });

        input.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const cursor = input.selectionStart;
                const before = input.value.slice(0, cursor);
                const after = input.value.slice(cursor);

                const existing = debounceMap.get(todo.id);
                if (existing) { clearTimeout(existing); debounceMap.delete(todo.id); }
                await updateTodoText(uid, todo.id, before);

                const newDoc = await addTodo(uid, dateEpoch, after);
                focusTarget = { id: newDoc.id, cursor: 0 };
                const idx = currentTodos.findIndex(t => t.id === todo.id);
                currentTodos = [
                    ...currentTodos.slice(0, idx),
                    { ...currentTodos[idx], text: before },
                    { id: newDoc.id, text: after, isDone: false, dateEpochDay: dateEpoch, sortOrder: Date.now(), moveCount: 0 },
                    ...currentTodos.slice(idx + 1)
                ];
                renderApp(currentTodos);
            }
            if (e.key === 'Backspace' && input.selectionStart === 0 && input.selectionEnd === 0) {
                e.preventDefault();
                const idx = currentTodos.findIndex(t => t.id === todo.id);
                const prev = currentTodos[idx - 1];
                if (!prev || prev.dateEpochDay !== dateEpoch) return;

                if (input.value === '') {
                    // Empty line: delete and move cursor to end of previous
                    focusTarget = { id: prev.id, cursor: prev.text.length };
                    await deleteTodo(uid, todo.id);
                } else {
                    // Has text: merge into previous line at join point
                    const cursorPos = prev.text.length;
                    focusTarget = { id: prev.id, cursor: cursorPos };
                    const existing = debounceMap.get(todo.id);
                    if (existing) { clearTimeout(existing); debounceMap.delete(todo.id); }
                    await updateTodoText(uid, prev.id, prev.text + input.value);
                    await deleteTodo(uid, todo.id);
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
