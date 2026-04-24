import { auth } from './firebase.js';
import { getTodayEpoch, addTodo, toggleTodo, updateTodoText, deleteTodo } from './todoService.js';
import { getUrgencyIntensity, isBadgeEnabled } from './settings.js';

const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const expandedStates = {};
const dirtyIds = new Set();

let currentTodos = [];
let focusTarget = null; // { id, cursor } to restore after render
let currentPage = 'todo';
let isAnimating = false;

const ANIM_KEY = 'todo-animated-day';
const saveTimers = new Map();

const PASTEL_COLORS = ['#F0DC8A', '#F0C880', '#F0B478', '#F0A074', '#EE9090'];
const VIVID_COLORS  = ['#E8C420', '#E89028', '#E06828', '#D44A28', '#C83232'];
const SOON_COLORS   = ['#E8D99A', '#E0B98A', '#E09090']; // 1 week, 2 weeks, 3+ weeks

function lerpColor(hex1, hex2, t) {
    const p = h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
    const [r1,g1,b1] = p(hex1);
    const [r2,g2,b2] = p(hex2);
    return `rgb(${Math.round(r1+(r2-r1)*t)},${Math.round(g1+(g2-g1)*t)},${Math.round(b1+(b2-b1)*t)})`;
}

function urgencyColor(moveCount, intensity) {
    if (intensity === 0) return 'var(--text)';
    const idx = Math.min(moveCount - 1, 4);
    const isDark = document.body.getAttribute('data-theme') !== 'light';
    const neutral = isDark ? '#FFFFFF' : '#121212';
    if (intensity <= 50) {
        return lerpColor(neutral, PASTEL_COLORS[idx], intensity / 50);
    } else {
        return lerpColor(PASTEL_COLORS[idx], VIVID_COLORS[idx], (intensity - 50) / 50);
    }
}

document.addEventListener('urgency-changed', () => renderApp(currentTodos));

function shouldAnimate(todayEpoch) {
    const last = parseInt(localStorage.getItem(ANIM_KEY) || '0');
    return last !== todayEpoch;
}

function markAnimated(todayEpoch) {
    localStorage.setItem(ANIM_KEY, String(todayEpoch));
}

async function typeInputs(inputs) {
    isAnimating = true;
    for (const input of inputs) {
        const fullText = input.dataset.fullText || '';
        input.value = '';
        for (const char of fullText) {
            await new Promise(r => setTimeout(r, 38));
            input.value += char;
        }
        await new Promise(r => setTimeout(r, 80)); // pause between todos
    }
    isAnimating = false;
}

// --- Shared helpers ---

function createCheckbox(todo, uid, todayUnchecked = false) {
    const wrapper = document.createElement('div');
    wrapper.className = 'checkbox-wrapper';
    const box = document.createElement('div');
    box.className = ['checkbox', todo.isDone ? 'checked' : '', todayUnchecked ? 'today-unchecked' : ''].filter(Boolean).join(' ');
    box.textContent = todo.isDone ? '✓' : '';
    wrapper.appendChild(box);
    wrapper.addEventListener('click', () => toggleTodo(uid, todo.id, !todo.isDone));
    return wrapper;
}

function scheduleSave(id, inputEl) {
    clearTimeout(saveTimers.get(id));
    saveTimers.set(id, setTimeout(() => {
        saveTimers.delete(id);
        const currentId = inputEl.dataset.id;
        if (currentId.startsWith('_pending_')) return;
        const uid = auth.currentUser?.uid;
        if (!uid || !dirtyIds.has(currentId)) return;
        dirtyIds.delete(currentId);
        const todo = currentTodos.find(t => t.id === currentId);
        if (todo) updateTodoText(uid, currentId, todo.text);
    }, 2000));
}

function attachBlurSave(input) {
    input.addEventListener('blur', () => {
        const id = input.dataset.id;
        clearTimeout(saveTimers.get(id));
        saveTimers.delete(id);
        if (id.startsWith('_pending_')) return;
        const uid = auth.currentUser?.uid;
        if (!uid || !dirtyIds.has(id)) return;
        dirtyIds.delete(id);
        const todo = currentTodos.find(t => t.id === id);
        if (todo) updateTodoText(uid, id, todo.text);
    });
}

// ---

export function setPage(page) {
    isAnimating = false;
    currentPage = page;
    renderApp(currentTodos);
}

export async function flushDirty() {
    const uid = auth.currentUser?.uid;
    if (!uid || dirtyIds.size === 0) return;
    const ids = [...dirtyIds];
    dirtyIds.clear();
    for (const id of ids) {
        if (id.startsWith('_pending_')) continue;
        const todo = currentTodos.find(t => t.id === id);
        if (todo) await updateTodoText(uid, id, todo.text);
    }
}

function updateBadge(todos) {
    if (!('setAppBadge' in navigator)) return;
    if (!isBadgeEnabled()) {
        navigator.clearAppBadge();
        return;
    }
    const today = getTodayEpoch();
    const count = todos.filter(t =>
        !t.isDone && (!t.page || t.page === 'todo') && t.dateEpochDay === today
    ).length;
    if (count > 0) {
        navigator.setAppBadge(count);
    } else {
        navigator.clearAppBadge();
    }
}

document.addEventListener('badge-changed', () => updateBadge(currentTodos));

export function scheduleRender(todos) {
    // Preserve any unsaved local text edits — don't let Firestore overwrite them
    const pendingTodos = currentTodos.filter(t => t.id.startsWith('_pending_'));
    currentTodos = todos.map(t => {
        if (dirtyIds.has(t.id)) {
            const local = currentTodos.find(l => l.id === t.id);
            return local || t;
        }
        return t;
    });
    updateBadge(currentTodos);
    // Skip re-render while an Enter is in flight — avoids losing the temp todo + focus
    if (pendingTodos.length > 0) return;
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

    if (isAnimating) return;

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

        if (shouldAnimate(today)) {
            markAnimated(today);
            const todaySection = [...container.querySelectorAll('.day-section')][1]; // index 1 = today (index 0 = yesterday)
            if (todaySection) {
                const inputs = [...todaySection.querySelectorAll('.todo-input')].filter(el => el.value.trim() !== '');
                // neue Todos zuerst, dann farbige (moveCount >= 1)
                inputs.sort((a, b) => {
                    const aMoved = (currentTodos.find(t => t.id === a.dataset.id)?.moveCount || 0) >= 1 ? 1 : 0;
                    const bMoved = (currentTodos.find(t => t.id === b.dataset.id)?.moveCount || 0) >= 1 ? 1 : 0;
                    return aMoved - bMoved;
                });
                inputs.forEach(el => { el.dataset.fullText = el.value; el.value = ''; });
                typeInputs(inputs).then(() => renderApp(currentTodos));
            }
        }
    } else {
        renderFlatSection(container, todos, uid);
    }

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

    const list = document.createElement('div');
    list.className = `todo-list${isOpen ? '' : ' hidden'}`;

    const urgencyIntensity = getUrgencyIntensity(); // cache once per day section render

    dayTodos.forEach(todo => {
        const row = document.createElement('div');
        row.className = `todo-row${todo.isDone ? ' done' : ''}`;

        let textColor = 'var(--text)';
        if (todo.isDone || isPast) {
            textColor = 'var(--text-muted)';
        } else if (todo.moveCount >= 1) {
            textColor = urgencyColor(todo.moveCount, urgencyIntensity);
        }

        row.appendChild(createCheckbox(todo, uid, isToday && !todo.isDone));

        const input = document.createElement('input');
        input.type = 'text';
        input.dataset.id = todo.id;
        input.className = `todo-input${todo.isDone ? ' done' : ''}`;
        input.value = todo.text;
        input.style.color = textColor;

        input.setAttribute('enterkeyhint', 'enter');

        input.addEventListener('input', () => {
            const id = input.dataset.id;
            const idx = currentTodos.findIndex(t => t.id === id);
            if (idx !== -1) currentTodos[idx] = { ...currentTodos[idx], text: input.value };
            dirtyIds.add(id);
            scheduleSave(id, input);
        });

        attachBlurSave(input);

        let enterInFlight = false;
        const onEnter = async (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (enterInFlight) return;
            enterInFlight = true;

            const cursor = input.selectionStart;
            const before = input.value.slice(0, cursor);
            const after = input.value.slice(cursor);
            const idx = currentTodos.findIndex(t => t.id === todo.id);

            const next = currentTodos.find((t, i) => i > idx && t.dateEpochDay === dateEpoch);
            const currentOrder = currentTodos[idx].sortOrder;
            const nextOrder = next ? next.sortOrder : currentOrder + 2000;
            const newSortOrder = (currentOrder + nextOrder) / 2;

            currentTodos[idx] = { ...currentTodos[idx], text: before };
            dirtyIds.add(todo.id);

            // render locally before async write so focus doesn't jump
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

            // Update ID in place — avoid full re-render so keyboard stays open on mobile
            currentTodos = currentTodos.map(t =>
                t.id === tempId ? { ...t, id: newDoc.id } : t
            );
            if (dirtyIds.has(tempId)) { dirtyIds.delete(tempId); dirtyIds.add(newDoc.id); }
            const tempEl = document.querySelector(`[data-id="${tempId}"]`);
            if (tempEl) tempEl.dataset.id = newDoc.id;

            enterInFlight = false;
        };

        // keypress is a fallback for Android keyboards that don't fire keydown on text inputs
        input.addEventListener('keypress', onEnter);
        input.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') { await onEnter(e); return; }

            if (e.key === 'Backspace' && input.selectionStart === 0 && input.selectionEnd === 0) {
                e.preventDefault();
                const idx = currentTodos.findIndex(t => t.id === todo.id);
                const prev = currentTodos.slice(0, idx).reverse().find(t => t.dateEpochDay === dateEpoch);
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

            // move focus directly without re-render
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

        row.appendChild(input);
        list.appendChild(row);
    });

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
    const siblings = pageTodos; // stable reference for keyboard navigation

    const list = document.createElement('div');
    list.className = 'todo-list flat-list';

    pageTodos.forEach(todo => {
        const row = document.createElement('div');
        row.className = `todo-row${todo.isDone ? ' done' : ''}`;

        row.appendChild(createCheckbox(todo, uid));

        const input = document.createElement('textarea');
        input.dataset.id = todo.id;
        input.className = `todo-input${todo.isDone ? ' done' : ''}`;
        input.value = todo.text;
        input.rows = 1;

        if (currentPage === 'soon' && !todo.isDone && todo.createdAt) {
            const ageWeeks = (Date.now() - todo.createdAt) / (7 * 24 * 60 * 60 * 1000);
            if (ageWeeks >= 3)      input.style.color = SOON_COLORS[2];
            else if (ageWeeks >= 2) input.style.color = SOON_COLORS[1];
            else if (ageWeeks >= 1) input.style.color = SOON_COLORS[0];
        }

        const autoGrow = () => {
            input.style.height = 'auto';
            input.style.height = input.scrollHeight + 'px';
        };

        input.addEventListener('input', () => {
            const id = input.dataset.id;
            const idx = currentTodos.findIndex(t => t.id === id);
            if (idx !== -1) currentTodos[idx] = { ...currentTodos[idx], text: input.value };
            dirtyIds.add(id);
            scheduleSave(id, input);
            autoGrow();
        });

        attachBlurSave(input);

        requestAnimationFrame(autoGrow);

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
                const sibIdx = siblings.findIndex(t => t.id === todo.id);
                const nextSib = siblings[sibIdx + 1];
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

                // Update ID in place — avoid full re-render so keyboard stays open on mobile
                currentTodos = currentTodos.map(t => t.id === tempId ? { ...t, id: newDoc.id } : t);
                if (dirtyIds.has(tempId)) { dirtyIds.delete(tempId); dirtyIds.add(newDoc.id); }
                const tempEl = document.querySelector(`[data-id="${tempId}"]`);
                if (tempEl) tempEl.dataset.id = newDoc.id;

                enterInFlight = false;
            }

            if (e.key === 'Backspace' && input.selectionStart === 0 && input.selectionEnd === 0) {
                e.preventDefault();
                const sibIdx = siblings.findIndex(t => t.id === todo.id);
                const prev = siblings[sibIdx - 1];

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
                const prev = siblings[siblings.findIndex(t => t.id === todo.id) - 1];
                if (prev) {
                    const el = document.querySelector(`[data-id="${prev.id}"]`);
                    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
                }
            }

            if (e.key === 'ArrowDown' && input.selectionStart === input.value.length) {
                e.preventDefault();
                const next = siblings[siblings.findIndex(t => t.id === todo.id) + 1];
                if (next) {
                    const el = document.querySelector(`[data-id="${next.id}"]`);
                    if (el) { el.focus(); el.setSelectionRange(0, 0); }
                }
            }
        });

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
