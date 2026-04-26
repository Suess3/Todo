import { auth } from './firebase.js';
import { getTodayEpoch, addTodo, toggleTodo, updateTodoText, deleteTodo, recordProductivity } from './todoService.js';
import { getUrgencyIntensity, isBadgeEnabled } from './settings.js';
import { triggerCheckAnimation } from './animations.js';

const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const expandedStates = {};
const dirtyIds = new Set();

let currentTodos = [];
let focusTarget = null; // { id, cursor } — focus a specific input after next render
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

// --- Checkbox ---

function createCheckbox(uid, isDone, todayUnchecked = false) {
    const wrapper = document.createElement('div');
    wrapper.className = 'checkbox-wrapper';
    const box = document.createElement('div');
    box.className = ['checkbox', isDone ? 'checked' : '', todayUnchecked ? 'today-unchecked' : ''].filter(Boolean).join(' ');
    box.textContent = isDone ? '✓' : '';
    wrapper.appendChild(box);
    // Read id from the row at click time so it stays correct after temp→real id swap
    wrapper.addEventListener('click', () => {
        const id = wrapper.closest('.todo-row')?.dataset.id;
        if (!id || id.startsWith('_pending_')) return;
        const current = currentTodos.find(t => t.id === id);
        if (!current) return;
        const newState = !current.isDone;
        if (newState) {
            triggerCheckAnimation(wrapper);
            // Only record productivity for the main todo page
            if (!current.page || current.page === 'todo') {
                recordProductivity(uid, current.moveCount || 0)
                    .catch(e => console.error('recordProductivity failed:', e));
            }
        }
        toggleTodo(uid, id, newState);
    });
    return wrapper;
}

function updateCheckbox(wrapper, isDone, todayUnchecked) {
    const box = wrapper.querySelector('.checkbox');
    // Use toggle instead of overwriting className so checkbox-bounce isn't interrupted mid-animation
    box.classList.toggle('checked', isDone);
    box.classList.toggle('today-unchecked', !!todayUnchecked);
    box.textContent = isDone ? '✓' : '';
}

// --- Save logic ---

function scheduleSave(id, inputEl) {
    clearTimeout(saveTimers.get(id));
    saveTimers.set(id, setTimeout(async () => {
        saveTimers.delete(id);
        const currentId = inputEl.dataset.id;
        if (currentId.startsWith('_pending_')) return;
        const uid = auth.currentUser?.uid;
        if (!uid || !dirtyIds.has(currentId)) return;
        const todo = currentTodos.find(t => t.id === currentId);
        if (!todo) return;
        dirtyIds.delete(currentId);
        try { await updateTodoText(uid, currentId, todo.text); }
        catch { dirtyIds.add(currentId); }
    }, 2000));
}

function attachBlurSave(input) {
    input.addEventListener('blur', async () => {
        const id = input.dataset.id;
        clearTimeout(saveTimers.get(id));
        saveTimers.delete(id);
        if (id.startsWith('_pending_')) return;
        const uid = auth.currentUser?.uid;
        if (!uid || !dirtyIds.has(id)) return;
        const todo = currentTodos.find(t => t.id === id);
        if (!todo) return;
        dirtyIds.delete(id);
        try { await updateTodoText(uid, id, todo.text); }
        catch { dirtyIds.add(id); }
    });
}

// --- Public API ---

export function setPage(page) {
    isAnimating = false;
    currentPage = page;
    renderApp(currentTodos);
}

export async function flushDirty() {
    const uid = auth.currentUser?.uid;
    if (!uid || dirtyIds.size === 0) return;
    const ids = [...dirtyIds].filter(id => !id.startsWith('_pending_'));
    await Promise.all(ids.map(async id => {
        const todo = currentTodos.find(t => t.id === id);
        if (!todo) return;
        dirtyIds.delete(id);
        try { await updateTodoText(uid, id, todo.text); }
        catch { dirtyIds.add(id); }
    }));
}

function updateBadge(todos) {
    if (!('setAppBadge' in navigator)) return;
    if (!isBadgeEnabled()) { navigator.clearAppBadge(); return; }
    const today = getTodayEpoch();
    const count = todos.filter(t =>
        !t.isDone && (!t.page || t.page === 'todo') && t.dateEpochDay === today
    ).length;
    count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
}

document.addEventListener('badge-changed', () => updateBadge(currentTodos));

export function scheduleRender(todos) {
    // Preserve unsaved local edits — don't let Firestore overwrite in-flight text
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

// --- Format helpers ---

function formatDate(epoch) {
    const d = new Date(epoch * 86400000);
    return d.getDate().toString().padStart(2, '0') + '. ' + MONTH_NAMES[d.getMonth()];
}

function getDayName(epoch) {
    return DAY_NAMES[new Date(epoch * 86400000).getDay()];
}

// --- Keyboard handlers ---

// Attached once per input on creation; reads current todo state from currentTodos at event time
// so it stays correct across reconciliation cycles without needing to be re-attached.
function attachCalendarKeyboard(input, getDateEpoch, uid) {
    let enterInFlight = false;

    const onEnter = async (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (enterInFlight) return;
        enterInFlight = true;

        const todoId = input.dataset.id;
        const dateEpoch = getDateEpoch();
        const cursor = input.selectionStart;
        const before = input.value.slice(0, cursor);
        const after = input.value.slice(cursor);
        const idx = currentTodos.findIndex(t => t.id === todoId);

        const next = currentTodos.find((t, i) => i > idx && t.dateEpochDay === dateEpoch);
        const currentOrder = currentTodos[idx].sortOrder;
        const nextOrder = next ? next.sortOrder : currentOrder + 2000;
        const newSortOrder = (currentOrder + nextOrder) / 2;

        currentTodos[idx] = { ...currentTodos[idx], text: before };
        dirtyIds.add(todoId);

        // Optimistic: insert temp todo locally so focus lands immediately
        const tempId = '_pending_' + Date.now();
        currentTodos = [
            ...currentTodos.slice(0, idx + 1),
            { id: tempId, text: after, isDone: false, dateEpochDay: dateEpoch, sortOrder: newSortOrder, moveCount: 0 },
            ...currentTodos.slice(idx + 1),
        ];
        focusTarget = { id: tempId, cursor: 0 };
        renderApp(currentTodos);

        const newDoc = await addTodo(uid, dateEpoch, after, newSortOrder);

        // Swap temp id for real id in state and DOM — avoids a full re-render that would close mobile keyboard
        currentTodos = currentTodos.map(t => t.id === tempId ? { ...t, id: newDoc.id } : t);
        if (dirtyIds.has(tempId)) { dirtyIds.delete(tempId); dirtyIds.add(newDoc.id); }
        document.querySelectorAll(`[data-id="${tempId}"]`).forEach(el => { el.dataset.id = newDoc.id; });

        enterInFlight = false;
    };

    // keypress is a fallback for Android keyboards that don't fire keydown on text inputs
    input.addEventListener('keypress', onEnter);
    input.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') { await onEnter(e); return; }

        const todoId = input.dataset.id;
        const dateEpoch = getDateEpoch();

        if (e.key === 'Backspace' && input.selectionStart === 0 && input.selectionEnd === 0) {
            e.preventDefault();
            const idx = currentTodos.findIndex(t => t.id === todoId);
            const prev = currentTodos.slice(0, idx).reverse().find(t => t.dateEpochDay === dateEpoch);

            if (!prev && input.value === '') {
                currentTodos = currentTodos.filter(t => t.id !== todoId);
                dirtyIds.delete(todoId);
                renderApp(currentTodos);
                deleteTodo(uid, todoId);
                return;
            }
            if (!prev) return;

            if (input.value === '') {
                focusTarget = { id: prev.id, cursor: prev.text.length };
                currentTodos = currentTodos.filter(t => t.id !== todoId);
                dirtyIds.delete(todoId);
                renderApp(currentTodos);
                deleteTodo(uid, todoId);
            } else {
                const mergedText = prev.text + input.value;
                const splitCursor = prev.text.length;
                const prevIdx = currentTodos.findIndex(t => t.id === prev.id);
                currentTodos[prevIdx] = { ...currentTodos[prevIdx], text: mergedText };
                dirtyIds.add(prev.id);
                currentTodos = currentTodos.filter(t => t.id !== todoId);
                dirtyIds.delete(todoId);
                focusTarget = { id: prev.id, cursor: splitCursor };
                renderApp(currentTodos);
                deleteTodo(uid, todoId);
            }
        }

        if (e.key === 'ArrowUp' && input.selectionStart === 0) {
            e.preventDefault();
            const idx = currentTodos.findIndex(t => t.id === todoId);
            const prev = currentTodos.slice(0, idx).reverse().find(t => t.dateEpochDay === dateEpoch);
            if (prev) {
                const el = document.querySelector(`.todo-input[data-id="${prev.id}"]`);
                if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
            }
        }

        if (e.key === 'ArrowDown' && input.selectionStart === input.value.length) {
            e.preventDefault();
            const idx = currentTodos.findIndex(t => t.id === todoId);
            const next = currentTodos.slice(idx + 1).find(t => t.dateEpochDay === dateEpoch);
            if (next) {
                const el = document.querySelector(`.todo-input[data-id="${next.id}"]`);
                if (el) { el.focus(); el.setSelectionRange(0, 0); }
            }
        }
    });
}

function attachFlatKeyboard(input, uid) {
    let enterInFlight = false;

    input.addEventListener('keydown', async (e) => {
        const todoId = input.dataset.id;
        // Read siblings fresh each event so ordering stays correct after adds/deletes
        const siblings = currentTodos.filter(t => t.page === currentPage);

        if (e.key === 'Enter') {
            e.preventDefault();
            if (enterInFlight) return;
            enterInFlight = true;

            const cursor = input.selectionStart;
            const before = input.value.slice(0, cursor);
            const after = input.value.slice(cursor);
            const idx = currentTodos.findIndex(t => t.id === todoId);
            const sibIdx = siblings.findIndex(t => t.id === todoId);
            const nextSib = siblings[sibIdx + 1];
            const currentOrder = currentTodos[idx].sortOrder;
            const nextOrder = nextSib ? nextSib.sortOrder : currentOrder + 2000;
            const newSortOrder = (currentOrder + nextOrder) / 2;

            currentTodos[idx] = { ...currentTodos[idx], text: before };
            dirtyIds.add(todoId);

            const tempId = '_pending_' + Date.now();
            currentTodos = [
                ...currentTodos.slice(0, idx + 1),
                { id: tempId, text: after, isDone: false, dateEpochDay: 0, sortOrder: newSortOrder, moveCount: 0, page: currentPage },
                ...currentTodos.slice(idx + 1),
            ];
            focusTarget = { id: tempId, cursor: 0 };
            renderApp(currentTodos);

            const newDoc = await addTodo(uid, 0, after, newSortOrder, currentPage);

            currentTodos = currentTodos.map(t => t.id === tempId ? { ...t, id: newDoc.id } : t);
            if (dirtyIds.has(tempId)) { dirtyIds.delete(tempId); dirtyIds.add(newDoc.id); }
            document.querySelectorAll(`[data-id="${tempId}"]`).forEach(el => { el.dataset.id = newDoc.id; });

            enterInFlight = false;
        }

        if (e.key === 'Backspace' && input.selectionStart === 0 && input.selectionEnd === 0) {
            e.preventDefault();
            const sibIdx = siblings.findIndex(t => t.id === todoId);
            const prev = siblings[sibIdx - 1];

            if (!prev && input.value === '') {
                currentTodos = currentTodos.filter(t => t.id !== todoId);
                dirtyIds.delete(todoId);
                renderApp(currentTodos);
                deleteTodo(uid, todoId);
                return;
            }
            if (!prev) return;

            if (input.value === '') {
                focusTarget = { id: prev.id, cursor: prev.text.length };
                currentTodos = currentTodos.filter(t => t.id !== todoId);
                dirtyIds.delete(todoId);
                renderApp(currentTodos);
                deleteTodo(uid, todoId);
            } else {
                const mergedText = prev.text + input.value;
                const splitCursor = prev.text.length;
                const prevIdx = currentTodos.findIndex(t => t.id === prev.id);
                currentTodos[prevIdx] = { ...currentTodos[prevIdx], text: mergedText };
                dirtyIds.add(prev.id);
                currentTodos = currentTodos.filter(t => t.id !== todoId);
                dirtyIds.delete(todoId);
                focusTarget = { id: prev.id, cursor: splitCursor };
                renderApp(currentTodos);
                deleteTodo(uid, todoId);
            }
        }

        if (e.key === 'ArrowUp' && input.selectionStart === 0) {
            e.preventDefault();
            const prev = siblings[siblings.findIndex(t => t.id === todoId) - 1];
            if (prev) {
                const el = document.querySelector(`.todo-input[data-id="${prev.id}"]`);
                if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
            }
        }

        if (e.key === 'ArrowDown' && input.selectionStart === input.value.length) {
            e.preventDefault();
            const next = siblings[siblings.findIndex(t => t.id === todoId) + 1];
            if (next) {
                const el = document.querySelector(`.todo-input[data-id="${next.id}"]`);
                if (el) { el.focus(); el.setSelectionRange(0, 0); }
            }
        }
    });
}

// --- Row color helpers ---

function calendarTextColor(todo, isPast, urgencyIntensity) {
    if (todo.isDone || isPast) return 'var(--text-muted)';
    if (todo.moveCount >= 1) return urgencyColor(todo.moveCount, urgencyIntensity);
    return 'var(--text)';
}

function applySoonColor(input, todo) {
    if (currentPage !== 'soon' || todo.isDone || !todo.createdAt) { input.style.color = ''; return; }
    const ageWeeks = (Date.now() - todo.createdAt) / (7 * 24 * 60 * 60 * 1000);
    if (ageWeeks >= 3)      input.style.color = SOON_COLORS[2];
    else if (ageWeeks >= 2) input.style.color = SOON_COLORS[1];
    else if (ageWeeks >= 1) input.style.color = SOON_COLORS[0];
    else                    input.style.color = '';
}

// --- Row create / update (calendar) ---

function createCalendarRow(todo, dateEpoch, isToday, isPast, uid, urgencyIntensity) {
    const row = document.createElement('div');
    row.className = `todo-row${todo.isDone ? ' done' : ''}`;
    row.dataset.id = todo.id;

    row.appendChild(createCheckbox(uid, todo.isDone, isToday && !todo.isDone));

    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.id = todo.id;
    input.className = `todo-input${todo.isDone ? ' done' : ''}`;
    input.value = todo.text;
    input.style.color = calendarTextColor(todo, isPast, urgencyIntensity);
    input.setAttribute('enterkeyhint', 'enter');

    input.addEventListener('input', () => {
        const id = input.dataset.id;
        const idx = currentTodos.findIndex(t => t.id === id);
        if (idx !== -1) currentTodos[idx] = { ...currentTodos[idx], text: input.value };
        dirtyIds.add(id);
        scheduleSave(id, input);
    });

    attachBlurSave(input);
    attachCalendarKeyboard(input, () => dateEpoch, uid);

    row.appendChild(input);
    return row;
}

function updateCalendarRow(row, todo, isToday, isPast, urgencyIntensity) {
    row.classList.toggle('done', todo.isDone);
    updateCheckbox(row.querySelector('.checkbox-wrapper'), todo.isDone, isToday && !todo.isDone);

    const input = row.querySelector('.todo-input');
    input.classList.toggle('done', todo.isDone);

    const textColor = calendarTextColor(todo, isPast, urgencyIntensity);
    if (input.style.color !== textColor) input.style.color = textColor;

    // Never overwrite text the user is actively editing or has unsaved changes
    if (document.activeElement !== input && !dirtyIds.has(todo.id)) {
        if (input.value !== todo.text) input.value = todo.text;
    }
}

// --- Row create / update (flat) ---

function createFlatRow(todo, uid) {
    const row = document.createElement('div');
    row.className = `todo-row${todo.isDone ? ' done' : ''}`;
    row.dataset.id = todo.id;

    row.appendChild(createCheckbox(uid, todo.isDone));

    const input = document.createElement('textarea');
    input.dataset.id = todo.id;
    input.className = `todo-input${todo.isDone ? ' done' : ''}`;
    input.value = todo.text;
    input.rows = 1;
    applySoonColor(input, todo);

    const autoGrow = () => { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; };

    input.addEventListener('input', () => {
        const id = input.dataset.id;
        const idx = currentTodos.findIndex(t => t.id === id);
        if (idx !== -1) currentTodos[idx] = { ...currentTodos[idx], text: input.value };
        dirtyIds.add(id);
        scheduleSave(id, input);
        autoGrow();
    });

    attachBlurSave(input);
    attachFlatKeyboard(input, uid);

    requestAnimationFrame(autoGrow);
    row.appendChild(input);
    return row;
}

function updateFlatRow(row, todo) {
    row.classList.toggle('done', todo.isDone);
    updateCheckbox(row.querySelector('.checkbox-wrapper'), todo.isDone, false);

    const input = row.querySelector('.todo-input');
    input.classList.toggle('done', todo.isDone);
    applySoonColor(input, todo);

    if (document.activeElement !== input && !dirtyIds.has(todo.id)) {
        if (input.value !== todo.text) {
            input.value = todo.text;
            // Re-measure height since content changed programmatically
            input.style.height = 'auto';
            input.style.height = input.scrollHeight + 'px';
        }
    }
}

// --- Core reconciliation ---

// Reuses existing DOM rows by key (data-id), moves them into correct order, removes stale ones.
// Existing rows are updated in place — the focused input is never destroyed.
function reconcileRows(list, todos, anchor, existingById, createRow, updateRow) {
    todos.forEach(todo => {
        let row = existingById.get(todo.id);
        if (row) {
            updateRow(row, todo);
            existingById.delete(todo.id);
        } else {
            row = createRow(todo);
        }
        list.insertBefore(row, anchor);
    });
    // Anything left in existingById was not in the new list — remove it
    existingById.forEach(row => row.remove());
}

// --- Main entry point ---

export function renderApp(todos) {
    const uid = auth.currentUser?.uid;
    if (!uid || isAnimating) return;

    const container = document.getElementById('app-content');

    if (currentPage === 'todo') {
        reconcileCalendarView(container, todos, uid);
    } else {
        reconcileFlatView(container, todos, uid);
    }

    // Restore focus after Enter (new todo) or Backspace (merge) operations
    if (focusTarget) {
        const el = container.querySelector(`.todo-input[data-id="${focusTarget.id}"]`);
        if (el) { el.focus(); el.setSelectionRange(focusTarget.cursor, focusTarget.cursor); }
        focusTarget = null;
    }
}

// --- Calendar view ---

function reconcileCalendarView(container, todos, uid) {
    container.querySelectorAll('.flat-list').forEach(el => el.remove());

    const today = getTodayEpoch();
    const epochs = Array.from({ length: 8 }, (_, i) => today - 1 + i);
    const epochSet = new Set(epochs);

    // Collect existing sections and remove any that have fallen out of the visible range
    const existingSections = new Map();
    container.querySelectorAll('.day-section[data-epoch]').forEach(s => {
        const epoch = Number(s.dataset.epoch);
        if (epochSet.has(epoch)) {
            existingSections.set(epoch, s);
        } else {
            s.remove();
        }
    });

    epochs.forEach(epoch => {
        const dayTodos = todos.filter(t => t.dateEpochDay === epoch && (!t.page || t.page === 'todo'));
        const existing = existingSections.get(epoch);

        if (existing) {
            reconcileDaySection(existing, epoch, today, dayTodos, uid);
        } else {
            const section = buildDaySection(epoch, today, dayTodos, uid);
            // Insert before the next existing section to maintain chronological order
            const nextSection = [...container.querySelectorAll('.day-section[data-epoch]')]
                .find(s => Number(s.dataset.epoch) > epoch);
            container.insertBefore(section, nextSection || null);
            existingSections.set(epoch, section);
        }
    });

    // Typing animation on first load of the day
    if (shouldAnimate(today)) {
        markAnimated(today);
        const todaySection = container.querySelector(`.day-section[data-epoch="${today}"]`);
        if (todaySection) {
            const inputs = [...todaySection.querySelectorAll('.todo-input')].filter(el => el.value.trim() !== '');
            // neue Todos zuerst animieren, dann farbige (moveCount >= 1)
            inputs.sort((a, b) => {
                const aMoved = (currentTodos.find(t => t.id === a.dataset.id)?.moveCount || 0) >= 1 ? 1 : 0;
                const bMoved = (currentTodos.find(t => t.id === b.dataset.id)?.moveCount || 0) >= 1 ? 1 : 0;
                return aMoved - bMoved;
            });
            inputs.forEach(el => { el.dataset.fullText = el.value; el.value = ''; });
            typeInputs(inputs).then(() => renderApp(currentTodos));
        }
    }
}

function buildDaySection(dateEpoch, today, dayTodos, uid) {
    const isPast = dateEpoch < today;
    const isToday = dateEpoch === today;
    if (expandedStates[dateEpoch] === undefined) expandedStates[dateEpoch] = !isPast;

    const section = document.createElement('div');
    section.className = 'day-section';
    section.dataset.epoch = dateEpoch;
    section.appendChild(buildDayHeader(dateEpoch, today));

    const isOpen = expandedStates[dateEpoch];
    const list = document.createElement('div');
    list.className = `todo-list${isOpen ? '' : ' hidden'}`;

    const urgencyIntensity = getUrgencyIntensity();
    dayTodos.forEach(todo => list.appendChild(createCalendarRow(todo, dateEpoch, isToday, isPast, uid, urgencyIntensity)));

    if (isOpen) list.appendChild(buildAddBtn(dayTodos.length === 0, 'No tasks (tap to add)', () => addTodo(uid, dateEpoch)));

    section.appendChild(list);
    return section;
}

function reconcileDaySection(section, dateEpoch, today, dayTodos, uid) {
    const isPast = dateEpoch < today;
    const isToday = dateEpoch === today;
    const isOpen = expandedStates[dateEpoch] ?? !isPast;

    section.querySelector('.toggle-icon')?.classList.toggle('closed', !isOpen);

    const list = section.querySelector('.todo-list');
    list.classList.toggle('hidden', !isOpen);

    const urgencyIntensity = getUrgencyIntensity();

    const existingById = new Map();
    list.querySelectorAll('.todo-row[data-id]').forEach(row => existingById.set(row.dataset.id, row));

    let addBtn = list.querySelector('.tap-to-add');
    if (!isOpen && addBtn) { addBtn.remove(); addBtn = null; }
    if (isOpen && !addBtn) {
        addBtn = buildAddBtn(dayTodos.length === 0, 'No tasks (tap to add)', () => addTodo(uid, dateEpoch));
        list.appendChild(addBtn);
    }
    if (addBtn) addBtn.textContent = dayTodos.length === 0 ? 'No tasks (tap to add)' : '';

    reconcileRows(
        list, dayTodos, addBtn,
        existingById,
        todo => createCalendarRow(todo, dateEpoch, isToday, isPast, uid, urgencyIntensity),
        (row, todo) => updateCalendarRow(row, todo, isToday, isPast, urgencyIntensity)
    );
}

function buildDayHeader(dateEpoch, today) {
    const isToday = dateEpoch === today;
    const isOpen = expandedStates[dateEpoch] ?? dateEpoch >= today;
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
    return header;
}

function buildAddBtn(isEmpty, emptyText, onClick) {
    const btn = document.createElement('div');
    btn.className = 'tap-to-add';
    if (isEmpty) btn.textContent = emptyText;
    btn.addEventListener('click', onClick);
    return btn;
}

// --- Flat view ---

function reconcileFlatView(container, todos, uid) {
    container.querySelectorAll('.day-section').forEach(s => s.remove());

    const pageTodos = todos.filter(t => t.page === currentPage);

    let list = container.querySelector('.todo-list.flat-list');
    if (!list) {
        list = document.createElement('div');
        list.className = 'todo-list flat-list';
        container.appendChild(list);
    }

    const existingById = new Map();
    list.querySelectorAll('.todo-row[data-id]').forEach(row => existingById.set(row.dataset.id, row));

    let addBtn = list.querySelector('.tap-to-add');
    if (!addBtn) {
        addBtn = buildAddBtn(pageTodos.length === 0, 'No items (tap to add)', () => addTodo(uid, 0, '', Date.now(), currentPage));
        list.appendChild(addBtn);
    }
    addBtn.textContent = pageTodos.length === 0 ? 'No items (tap to add)' : '';

    reconcileRows(
        list, pageTodos, addBtn,
        existingById,
        todo => createFlatRow(todo, uid),
        (row, todo) => updateFlatRow(row, todo)
    );
}
