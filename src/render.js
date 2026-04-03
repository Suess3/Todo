import { auth } from './firebase.js';
import { getTodayEpoch, addTodo, toggleTodo, updateTodoText, deleteTodo } from './todoService.js';

const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const expandedStates = {};
const debounceMap = new Map();

let currentTodos = [];
let pendingRender = false;
let focusId = null; // ID of todo to focus after next render

// Called from app.js on every Firestore update.
// Defers the render if a todo-input is focused (user is actively typing).
export function scheduleRender(todos) {
    currentTodos = todos;
    const active = document.activeElement;
    if (active && active.classList.contains('todo-input')) {
        pendingRender = true;
        return;
    }
    renderApp(todos);
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

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

    const today = getTodayEpoch();
    const container = document.getElementById('app-content');
    container.innerHTML = '';

    for (let i = -1; i <= 6; i++) {
        renderDaySection(container, today + i, today, todos, uid);
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
        scheduleRender(currentTodos);
    });
    section.appendChild(header);

    // List
    const list = document.createElement('div');
    list.className = `todo-list${isOpen ? '' : ' hidden'}`;

    dayTodos.forEach(todo => {
        const row = document.createElement('div');
        row.className = `todo-row${todo.isDone ? ' done' : ''}`;

        // Color: done or past = gray (handled by CSS .done), else by moveCount
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
        checkbox.className = [
            'checkbox',
            todo.isDone ? 'checked' : '',
            isToday && !todo.isDone ? 'today-unchecked' : ''
        ].join(' ').trim();
        checkbox.textContent = todo.isDone ? '✓' : '';
        checkWrapper.appendChild(checkbox);
        checkWrapper.addEventListener('click', () => toggleTodo(uid, todo.id, !todo.isDone));

        // Input — value set via .value to avoid XSS
        const input = document.createElement('input');
        input.type = 'text';
        input.dataset.id = todo.id;
        input.className = `todo-input${todo.isDone ? ' done' : ''}`;
        input.value = todo.text;
        input.style.color = textColor;

        if (focusId === todo.id) {
            focusId = null;
            requestAnimationFrame(() => { input.focus(); input.setSelectionRange(0, 0); });
        }

        input.addEventListener('input', () => {
            const existing = debounceMap.get(todo.id);
            if (existing) clearTimeout(existing);
            debounceMap.set(todo.id, setTimeout(() => {
                updateTodoText(uid, todo.id, input.value);
                debounceMap.delete(todo.id);
            }, 500));
        });

        input.addEventListener('blur', () => {
            // Flush any pending debounce immediately on blur
            const existing = debounceMap.get(todo.id);
            if (existing) {
                clearTimeout(existing);
                debounceMap.delete(todo.id);
                updateTodoText(uid, todo.id, input.value);
            }
            if (pendingRender) {
                pendingRender = false;
                renderApp(currentTodos);
            }
        });

        input.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const cursor = input.selectionStart;
                const before = input.value.slice(0, cursor);
                const after = input.value.slice(cursor);

                // Cancel debounce and save the before-text immediately
                const existing = debounceMap.get(todo.id);
                if (existing) { clearTimeout(existing); debounceMap.delete(todo.id); }
                await updateTodoText(uid, todo.id, before);

                // Create new todo with the after-text and focus it when it renders
                const newDoc = await addTodo(uid, dateEpoch, after);
                focusId = newDoc.id;
                pendingRender = false;
            }
            if (e.key === 'Backspace' && input.value === '') {
                e.preventDefault();
                pendingRender = false;
                await deleteTodo(uid, todo.id);
                renderApp(currentTodos);
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
