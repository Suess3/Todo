// Core renderer: DOM-diffing reconciliation, the calendar view (todo) and the
// flat views (soon/longRun/keepInMind), plus the textarea-based row handling.
// Notes-specific code lives in notes.js, drag & drop in dragdrop.js, save logic
// in save.js, shared state in store.js.

import { auth } from './firebase.js';
import { getTodayEpoch, addTodo, toggleTodo, deleteTodo, recordProductivity } from './todoService.js';
import { getUrgencyIntensity } from './settings.js';
import { triggerCheckAnimation, triggerCascade } from './animations.js';
import { t } from './i18n.js';
import { todos, setTodos, dirtyIds, currentPage, setCurrentPage, focusTarget, setFocusTarget, flatDepthMap, setRenderer } from './store.js';
import { showToast } from './feedback.js';
import { scheduleSave, attachBlurSave, commitTempTodo } from './save.js';
import { createNoteRow, updateNoteRow, placeCaretAtStart, placeCaretAtEnd, placeCaretAtTextOffset } from './notes.js';
import { recordChange, recordToggle } from './history.js';
import { applySelectionClasses, clearSelection } from './selection.js';
import './dragdrop.js';

const expandedStates = {};
let isAnimating = false;
let animationCancelToken = null;

const ANIM_KEY = 'todo-animated-day';

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

document.addEventListener('urgency-changed', () => renderApp(todos));
document.addEventListener('lang-changed', () => renderApp(todos));

// --- Typing animation (first open of the day) ---

// Only when someone is looking and nobody is typing: a rollover can happen in a
// background tab or with the cursor sitting in today's list
function shouldAnimate(todayEpoch) {
    if (document.visibilityState !== 'visible') return false;
    if (document.activeElement?.classList.contains('todo-input')) return false;
    const last = parseInt(localStorage.getItem(ANIM_KEY) || '0');
    return last !== todayEpoch;
}

function markAnimated(todayEpoch) {
    localStorage.setItem(ANIM_KEY, String(todayEpoch));
}

function cancelTypingAnimation() {
    if (!animationCancelToken) return;
    animationCancelToken.cancelled = true;
    animationCancelToken = null;
    isAnimating = false;
    document.querySelectorAll('.todo-input[data-full-text]').forEach(el => {
        el.value = el.dataset.fullText;
        el.removeAttribute('data-full-text');
    });
}

async function typeInputs(inputs) {
    const token = { cancelled: false };
    animationCancelToken = token;
    isAnimating = true;
    for (const input of inputs) {
        if (token.cancelled) break;
        const fullText = input.dataset.fullText || '';
        input.value = '';
        for (const char of fullText) {
            if (token.cancelled) break;
            await new Promise(r => setTimeout(r, 12));
            if (token.cancelled) break;
            input.value += char;
        }
        if (token.cancelled) break;
        await new Promise(r => setTimeout(r, 30));
    }
    if (!token.cancelled) {
        isAnimating = false;
        animationCancelToken = null;
        renderApp(todos);
    }
}

// Cancel the typing animation on any user interaction so the UI stays fully responsive
document.addEventListener('pointerdown', () => {
    if (isAnimating) cancelTypingAnimation();
}, { capture: true });

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
        const current = todos.find(t => t.id === id);
        if (!current) return;
        const newState = !current.isDone;
        const countsProductivity = newState && (!current.page || current.page === 'todo');
        recordToggle(id, current.isDone, current.moveCount || 0, countsProductivity);
        if (newState) {
            triggerCheckAnimation(wrapper);
            // Only record productivity for the main todo page
            if (!current.page || current.page === 'todo') {
                recordProductivity(uid, current.moveCount || 0)
                    .catch(e => console.error('recordProductivity failed:', e));
                // Fire cascade if this was the last unchecked todo for today
                const today = getTodayEpoch();
                const todayTodos = todos.filter(t => t.dateEpochDay === today && (!t.page || t.page === 'todo') && t.text.trim() !== '');
                const allDoneAfterThis = todayTodos.length > 0 && todayTodos.every(t => t.id === id || t.isDone);
                if (allDoneAfterThis) setTimeout(triggerCascade, 400);
            }
        }
        toggleTodo(uid, id, newState).catch(e => {
            showToast(t('err_update_status'), 'error');
            console.error(e);
        });
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

// --- Public API ---

const isCoarsePointer = window.matchMedia('(pointer: coarse)');

export function setPage(page) {
    cancelTypingAnimation();
    clearSelection();
    setCurrentPage(page);
    renderApp(todos);
}

export function scheduleRender(newTodos) {
    // Preserve unsaved local edits — don't let Firestore overwrite in-flight text
    const pendingTodos = todos.filter(t => t.id.startsWith('_pending_'));
    setTodos(newTodos.map(t => {
        if (dirtyIds.has(t.id)) {
            const local = todos.find(l => l.id === t.id);
            return local || t;
        }
        return t;
    }));
    // Skip re-render while an Enter is in flight — avoids losing the temp todo + focus
    if (pendingTodos.length > 0) return;
    // Touch only: skip re-render while the user is editing — moving the focused row
    // dismisses the iOS keyboard. Desktop renders anyway (renderApp keeps the focus),
    // otherwise an always-open laptop tab never shows edits made on the phone.
    // Only skip if todo inputs are already in the DOM (i.e. not the initial render)
    if (isCoarsePointer.matches && document.querySelector('.todo-input') && document.activeElement?.classList.contains('todo-input')) return;
    renderApp(todos);
}

// --- Format helpers ---

// Epochs are UTC midnights of the local calendar date (getTodayEpoch), so they
// have to be read back in UTC — local getters return the previous day west of UTC
function formatDate(epoch) {
    const d = new Date(epoch * 86400000);
    return d.getUTCDate().toString().padStart(2, '0') + '. ' + t('month_' + d.getUTCMonth());
}

function getDayName(epoch) {
    return t('day_' + new Date(epoch * 86400000).getUTCDay());
}

// --- Keyboard handler (textarea-based rows: todo/soon/longRun) ---

// Attached once per input on creation; reads current todo state from the store at event time
// so it stays correct across reconciliation cycles without needing to be re-attached.
// getSiblings()                    → filtered list of todos for this view (for nav / backspace)
// makeTempTodo(tempId, after, s)   → optimistic todo object to insert locally
// persistTodo(after, sortOrder)    → calls addTodo with the right page/date args
function attachKeyboard(input, uid, getSiblings, makeTempTodo, persistTodo) {
    let enterInFlight = false;

    const onEnter = async (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        // Cmd/Ctrl+Enter checks the row off — through the checkbox itself, so the
        // animation, productivity counter and undo entry all stay in one place
        if (e.metaKey || e.ctrlKey) {
            if (e.type === 'keydown') input.closest('.todo-row')?.querySelector('.checkbox-wrapper')?.click();
            return;
        }
        if (enterInFlight) return;
        enterInFlight = true;

        // Wrapped in try/finally so any unexpected error can never leave enterInFlight stuck
        // true — which would silently make Enter a no-op on this row forever after.
        try {
            const todoId = input.dataset.id;
            const siblings = getSiblings();
            const originalText = input.value;
            const cursor = input.selectionStart;
            const before = input.value.slice(0, cursor);
            const after = input.value.slice(cursor);
            const idx = todos.findIndex(t => t.id === todoId);
            if (idx === -1) return;
            const sibIdx = siblings.findIndex(t => t.id === todoId);
            const nextSib = siblings[sibIdx + 1];
            const currentOrder = todos[idx].sortOrder;
            const nextOrder = nextSib ? nextSib.sortOrder : currentOrder + 2000;
            const newSortOrder = (currentOrder + nextOrder) / 2;

            todos[idx] = { ...todos[idx], text: before };
            dirtyIds.add(todoId);

            // Optimistic: insert temp todo locally so focus lands immediately
            const tempId = '_pending_' + Date.now();
            setTodos([
                ...todos.slice(0, idx + 1),
                makeTempTodo(tempId, after, newSortOrder),
                ...todos.slice(idx + 1),
            ]);
            setFocusTarget({ id: tempId, cursor: 0 });
            renderApp(todos);

            const split = await commitTempTodo(tempId, persistTodo(after, newSortOrder));
            if (split) recordChange({ created: [split.id], textRestores: [{ id: todoId, text: originalText }] });
        } finally {
            enterInFlight = false;
        }
    };

    // keypress is a fallback for Android keyboards that don't fire keydown on text inputs
    input.addEventListener('keypress', onEnter);
    input.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') { await onEnter(e); return; }

        const todoId = input.dataset.id;
        const siblings = getSiblings();

        if (e.key === 'Backspace' && input.selectionStart === 0 && input.selectionEnd === 0) {
            e.preventDefault();
            const sibIdx = siblings.findIndex(t => t.id === todoId);
            const prev = siblings[sibIdx - 1];

            if (!prev && input.value === '') {
                recordChange({ removed: [{ ...todos.find(t => t.id === todoId) }] });
                setTodos(todos.filter(t => t.id !== todoId));
                dirtyIds.delete(todoId);
                renderApp(todos);
                deleteTodo(uid, todoId).catch(e => { showToast(t('err_delete'), 'error'); console.error(e); });
                return;
            }
            if (!prev) return;

            if (input.value === '') {
                setFocusTarget({ id: prev.id, cursor: prev.text.length });
                recordChange({ removed: [{ ...todos.find(t => t.id === todoId) }] });
                setTodos(todos.filter(t => t.id !== todoId));
                dirtyIds.delete(todoId);
                renderApp(todos);
                deleteTodo(uid, todoId).catch(e => { showToast(t('err_delete'), 'error'); console.error(e); });
            } else {
                const mergedText = prev.text + input.value;
                const splitCursor = prev.text.length;
                const prevIdx = todos.findIndex(t => t.id === prev.id);
                todos[prevIdx] = { ...todos[prevIdx], text: mergedText };
                dirtyIds.add(prev.id);
                // Write the merge straight into prev's DOM node — the dirty flag we just set
                // would otherwise make the reconcile below skip refreshing its (already-rendered) value
                const prevEl = document.querySelector(`.todo-input[data-id="${prev.id}"]`);
                if (prevEl) prevEl.value = mergedText;
                recordChange({
                    removed: [{ ...todos.find(t => t.id === todoId) }],
                    textRestores: [{ id: prev.id, text: prev.text }],
                });
                setTodos(todos.filter(t => t.id !== todoId));
                dirtyIds.delete(todoId);
                setFocusTarget({ id: prev.id, cursor: splitCursor });
                renderApp(todos);
                deleteTodo(uid, todoId).catch(e => { showToast(t('err_delete'), 'error'); console.error(e); });
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

    const dragHandle = document.createElement('div');
    dragHandle.className = 'drag-handle';
    dragHandle.innerHTML = '⋮⋮';
    row.appendChild(dragHandle);

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
        const idx = todos.findIndex(t => t.id === id);
        if (idx !== -1) todos[idx] = { ...todos[idx], text: input.value };
        dirtyIds.add(id);
        scheduleSave(id, input);
    });

    attachBlurSave(input);
    attachKeyboard(
        input, uid,
        () => todos.filter(t => t.dateEpochDay === dateEpoch),
        (tempId, after, s) => ({ id: tempId, text: after, isDone: false, dateEpochDay: dateEpoch, sortOrder: s, moveCount: 0 }),
        (after, s) => addTodo(uid, dateEpoch, after, s)
    );

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

// --- Row create / update (flat: soon/longRun) ---

function createFlatRow(todo, uid) {
    const row = document.createElement('div');
    row.className = `todo-row${todo.isDone ? ' done' : ''}`;
    row.dataset.id = todo.id;

    const dragHandle = document.createElement('div');
    dragHandle.className = 'drag-handle';
    dragHandle.innerHTML = '⋮⋮';
    row.appendChild(dragHandle);

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
        const idx = todos.findIndex(t => t.id === id);
        if (idx !== -1) todos[idx] = { ...todos[idx], text: input.value };
        dirtyIds.add(id);
        scheduleSave(id, input);
        autoGrow();
    });

    attachBlurSave(input);
    attachKeyboard(
        input, uid,
        () => todos.filter(t => t.page === currentPage),
        (tempId, after, s) => ({ id: tempId, text: after, isDone: false, dateEpochDay: 0, sortOrder: s, moveCount: 0, page: currentPage }),
        (after, s) => addTodo(uid, 0, after, s, currentPage)
    );

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
// Rows are only moved when they're actually out of place: every insertBefore of a
// row detaches it, which blurs a focused input and costs a layout pass.
function reconcileRows(list, rowTodos, anchor, existingById, createRow, updateRow) {
    const rows = rowTodos.map(todo => {
        const row = existingById.get(todo.id);
        if (!row) return createRow(todo);
        updateRow(row, todo);
        existingById.delete(todo.id);
        return row;
    });
    // Anything left in existingById was not in the new list — remove it
    existingById.forEach(row => row.remove());
    // Walk backwards from the anchor so each check compares against final positions
    let next = anchor;
    for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].nextSibling !== next || rows[i].parentNode !== list) list.insertBefore(rows[i], next);
        next = rows[i];
    }
}

// A reorder can still have to move the focused row; put the focus and caret back
// so a background sync never interrupts typing.
function captureFocus() {
    const el = document.activeElement;
    if (!el?.classList.contains('todo-input')) return null;
    if (el.isContentEditable) {
        const sel = window.getSelection();
        if (!sel.rangeCount || !el.contains(sel.anchorNode)) return { el, offset: null };
        const pre = document.createRange();
        pre.selectNodeContents(el);
        pre.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
        return { el, offset: pre.toString().length };
    }
    return { el, start: el.selectionStart, end: el.selectionEnd };
}

function restoreFocus(saved) {
    if (!saved || document.activeElement === saved.el || !saved.el.isConnected) return;
    saved.el.focus({ preventScroll: true });
    if (saved.el.isContentEditable) {
        if (saved.offset !== null) placeCaretAtTextOffset(saved.el, saved.offset);
    } else {
        saved.el.setSelectionRange(saved.start, saved.end);
    }
}

// --- Main entry point ---

export function renderApp(renderTodos) {
    const uid = auth.currentUser?.uid;
    if (!uid || isAnimating) return;

    const container = document.getElementById('app-content');
    const focused = focusTarget ? null : captureFocus();

    if (currentPage === 'todo') {
        reconcileCalendarView(container, renderTodos, uid);
    } else {
        reconcileFlatView(container, renderTodos, uid);
    }
    restoreFocus(focused);

    // Restore focus after Enter (new todo) or Backspace (merge) operations
    if (focusTarget) {
        const el = container.querySelector(`.todo-input[data-id="${focusTarget.id}"]`);
        if (el) {
            el.focus();
            if (el.isContentEditable) {
                if (focusTarget.cursor === 'end') placeCaretAtEnd(el);
                else if (focusTarget.cursor === 'start') placeCaretAtStart(el);
                else placeCaretAtTextOffset(el, focusTarget.cursor);
            } else {
                el.setSelectionRange(focusTarget.cursor, focusTarget.cursor);
            }
        }
        setFocusTarget(null);
    }

    applySelectionClasses();
}

setRenderer(renderApp);

// --- Calendar view ---

let renderedToday = null;

function reconcileCalendarView(container, renderTodos, uid) {
    container.querySelectorAll('.flat-list').forEach(el => el.remove());

    const today = getTodayEpoch();
    // New day while the app stayed open: start from the same open/closed state a
    // fresh load would have, so yesterday folds away instead of staying expanded
    if (renderedToday !== null && renderedToday !== today) {
        Object.keys(expandedStates).forEach(k => delete expandedStates[k]);
    }
    renderedToday = today;
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
        const dayTodos = renderTodos.filter(t => t.dateEpochDay === epoch && (!t.page || t.page === 'todo'));
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
            // Animate new todos first, then the carried-over (colored) ones
            inputs.sort((a, b) => {
                const aMoved = (todos.find(t => t.id === a.dataset.id)?.moveCount || 0) >= 1 ? 1 : 0;
                const bMoved = (todos.find(t => t.id === b.dataset.id)?.moveCount || 0) >= 1 ? 1 : 0;
                return aMoved - bMoved;
            });
            inputs.forEach(el => { el.dataset.fullText = el.value; el.value = ''; });
            typeInputs(inputs).then(() => renderApp(todos));
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

    if (isOpen) list.appendChild(buildAddBtn(dayTodos.length === 0, t('no_tasks'), () => addTodo(uid, dateEpoch).catch(e => { showToast(t('err_create_todo'), 'error'); console.error(e); })));

    section.appendChild(list);
    return section;
}

function reconcileDaySection(section, dateEpoch, today, dayTodos, uid) {
    const isPast = dateEpoch < today;
    const isToday = dateEpoch === today;
    const isOpen = expandedStates[dateEpoch] ?? !isPast;

    const weekdayEl = section.querySelector('.weekday');
    if (weekdayEl) {
        weekdayEl.textContent = getDayName(dateEpoch);
        weekdayEl.classList.toggle('today', isToday);
    }
    const dateEl = section.querySelector('.date-small');
    if (dateEl) dateEl.textContent = formatDate(dateEpoch);

    section.querySelector('.toggle-icon')?.classList.toggle('closed', !isOpen);

    const list = section.querySelector('.todo-list');
    list.classList.toggle('hidden', !isOpen);

    const urgencyIntensity = getUrgencyIntensity();

    const existingById = new Map();
    list.querySelectorAll('.todo-row[data-id]').forEach(row => existingById.set(row.dataset.id, row));

    let addBtn = list.querySelector('.tap-to-add');
    if (!isOpen && addBtn) { addBtn.remove(); addBtn = null; }
    if (isOpen && !addBtn) {
        addBtn = buildAddBtn(dayTodos.length === 0, t('no_tasks'), () => addTodo(uid, dateEpoch).catch(e => { showToast(t('err_create_todo'), 'error'); console.error(e); }));
        list.appendChild(addBtn);
    }
    if (addBtn) addBtn.textContent = dayTodos.length === 0 ? t('no_tasks') : '';

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
        expandedStates[dateEpoch] = !(expandedStates[dateEpoch] ?? dateEpoch >= getTodayEpoch());
        renderApp(todos);
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

// --- Flat view (soon/longRun/keepInMind) ---

// Builds the display order. Only keepInMind actually nests: depth-first walk,
// collapsed toggles' children are skipped entirely (not just hidden), and
// flatDepthMap gets the indentation depth per id.
function flattenForDisplay(pageTodos) {
    flatDepthMap.clear();

    if (currentPage !== 'keepInMind') {
        const sorted = [...pageTodos].sort((a, b) => a.sortOrder - b.sortOrder);
        sorted.forEach(t => flatDepthMap.set(t.id, 0));
        return sorted;
    }

    const childrenOf = new Map();
    pageTodos.forEach(todo => {
        const key = todo.parentId || null;
        if (!childrenOf.has(key)) childrenOf.set(key, []);
        childrenOf.get(key).push(todo);
    });
    childrenOf.forEach(list => list.sort((a, b) => a.sortOrder - b.sortOrder));

    const result = [];
    (function walk(parentId, depth) {
        (childrenOf.get(parentId) || []).forEach(node => {
            flatDepthMap.set(node.id, depth);
            result.push(node);
            if (!node.isToggle || !node.collapsed) walk(node.id, depth + 1);
        });
    })(null, 0);

    return result;
}

function reconcileFlatView(container, renderTodos, uid) {
    container.querySelectorAll('.day-section').forEach(s => s.remove());

    const pageTodos = renderTodos.filter(t => t.page === currentPage);
    const displayTodos = flattenForDisplay(pageTodos);

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
        addBtn = buildAddBtn(pageTodos.length === 0, t('no_items'), () => addTodo(uid, 0, '', Date.now(), currentPage).catch(e => { showToast(t('err_create_item'), 'error'); console.error(e); }));
        list.appendChild(addBtn);
    }
    addBtn.textContent = pageTodos.length === 0 ? t('no_items') : '';

    const isNotes = currentPage === 'keepInMind';
    reconcileRows(
        list, displayTodos, addBtn,
        existingById,
        todo => isNotes ? createNoteRow(todo, uid) : createFlatRow(todo, uid),
        (row, todo) => isNotes ? updateNoteRow(row, todo, uid) : updateFlatRow(row, todo)
    );
}
