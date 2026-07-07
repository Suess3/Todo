import { auth } from './firebase.js';
import { getTodayEpoch, addTodo, toggleTodo, updateTodoText, updateSortOrder, deleteTodo, recordProductivity, setIsToggle, setCollapsed, setParent } from './todoService.js';
import { getUrgencyIntensity } from './settings.js';
import { triggerCheckAnimation, triggerCascade } from './animations.js';
import { t } from './i18n.js';
const expandedStates = {};
const dirtyIds = new Set();

let currentTodos = [];
let focusTarget = null; // { id, cursor } — focus a specific input after next render
let currentPage = 'todo';
let isAnimating = false;
let animationCancelToken = null;

const ANIM_KEY = 'todo-animated-day';
const saveTimers = new Map();

function updateSaveStatus(status) {
    const el = document.getElementById('save-status');
    if (!el) return;
    el.classList.remove('hidden', 'error');
    if (status === 'saving') {
        el.textContent = 'Saving…';
    } else if (status === 'error') {
        el.textContent = 'Save failed';
        el.classList.add('error');
    } else {
        el.classList.add('hidden');
    }
}

export function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        toast.style.transition = 'opacity 0.3s, transform 0.3s';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

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
document.addEventListener('lang-changed', () => renderApp(currentTodos));

function shouldAnimate(todayEpoch) {
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
        renderApp(currentTodos);
    }
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
                // Fire cascade if this was the last unchecked todo for today
                const today = getTodayEpoch();
                const todayTodos = currentTodos.filter(t => t.dateEpochDay === today && (!t.page || t.page === 'todo') && t.text.trim() !== '');
                const allDoneAfterThis = todayTodos.length > 0 && todayTodos.every(t => t.id === id || t.isDone);
                if (allDoneAfterThis) setTimeout(triggerCascade, 400);
            }
        }
        toggleTodo(uid, id, newState).catch(e => {
            showToast('Failed to update status', 'error');
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
        updateSaveStatus('saving');
        try { 
            await updateTodoText(uid, currentId, todo.text); 
            updateSaveStatus('idle');
        } catch (e) { 
            dirtyIds.add(currentId); 
            updateSaveStatus('error');
            showToast('Failed to save changes', 'error');
            console.error(e);
        }
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
        updateSaveStatus('saving');
        try { 
            await updateTodoText(uid, id, todo.text); 
            updateSaveStatus('idle');
        } catch (e) { 
            dirtyIds.add(id); 
            updateSaveStatus('error');
            showToast('Failed to save changes', 'error');
            console.error(e);
        }
    });
}

// --- Public API ---

export function setPage(page) {
    cancelTypingAnimation();
    currentPage = page;
    renderApp(currentTodos);
}

export async function flushDirty() {
    const uid = auth.currentUser?.uid;
    if (!uid || dirtyIds.size === 0) return;
    const ids = [...dirtyIds].filter(id => !id.startsWith('_pending_'));
    if (ids.length === 0) return;
    
    updateSaveStatus('saving');
    try {
        await Promise.all(ids.map(async id => {
            const todo = currentTodos.find(t => t.id === id);
            if (!todo) return;
            dirtyIds.delete(id);
            try { await updateTodoText(uid, id, todo.text); }
            catch (e) { 
                dirtyIds.add(id); 
                throw e;
            }
        }));
        updateSaveStatus('idle');
    } catch (e) {
        updateSaveStatus('error');
        showToast('Sync failed', 'error');
        console.error(e);
    }
}


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
    // Skip re-render while an Enter is in flight — avoids losing the temp todo + focus
    if (pendingTodos.length > 0) return;
    // Skip re-render while user is actively editing — insertBefore triggers iOS keyboard dismissal
    // Only skip if todo inputs are already in the DOM (i.e. not the initial render)
    if (document.querySelector('.todo-input') && document.activeElement?.classList.contains('todo-input')) return;
    renderApp(currentTodos);
}

// --- Format helpers ---

function formatDate(epoch) {
    const d = new Date(epoch * 86400000);
    return d.getDate().toString().padStart(2, '0') + '. ' + t('month_' + d.getMonth());
}

function getDayName(epoch) {
    return t('day_' + new Date(epoch * 86400000).getDay());
}

// --- Keyboard handlers ---

// Attached once per input on creation; reads current todo state from currentTodos at event time
// so it stays correct across reconciliation cycles without needing to be re-attached.
// getSiblings()                    → filtered list of todos for this view (for nav / backspace)
// makeTempTodo(tempId, after, s)   → optimistic todo object to insert locally
// persistTodo(after, sortOrder)    → calls addTodo with the right page/date args
// Deleting a toggle shouldn't orphan its children — reparent them to the toggle's own parent first.
// Shared with attachNoteKeyboard (Notes); no-op elsewhere since only Notes todos have parentId set.
function promoteChildren(uid, todoId) {
    const children = currentTodos.filter(t => t.parentId === todoId);
    if (children.length === 0) return;
    const deleted = currentTodos.find(t => t.id === todoId);
    const newParentId = deleted?.parentId || null;
    currentTodos = currentTodos.map(t => t.parentId === todoId ? { ...t, parentId: newParentId } : t);
    children.forEach(c => setParent(uid, c.id, newParentId).catch(e => console.error(e)));
}

function attachKeyboard(input, uid, getSiblings, makeTempTodo, persistTodo) {
    let enterInFlight = false;

    const onEnter = async (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (enterInFlight) return;
        enterInFlight = true;

        const todoId = input.dataset.id;
        const siblings = getSiblings();
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

        // Optimistic: insert temp todo locally so focus lands immediately
        const tempId = '_pending_' + Date.now();
        currentTodos = [
            ...currentTodos.slice(0, idx + 1),
            makeTempTodo(tempId, after, newSortOrder),
            ...currentTodos.slice(idx + 1),
        ];
        focusTarget = { id: tempId, cursor: 0 };
        renderApp(currentTodos);

        try {
            updateSaveStatus('saving');
            const newDoc = await persistTodo(after, newSortOrder);
            updateSaveStatus('idle');

            // Swap temp id for real id in state and DOM — avoids a full re-render that would close mobile keyboard
            currentTodos = currentTodos.map(t => t.id === tempId ? { ...t, id: newDoc.id } : t);
            if (dirtyIds.has(tempId)) { dirtyIds.delete(tempId); dirtyIds.add(newDoc.id); }
            document.querySelectorAll(`[data-id="${tempId}"]`).forEach(el => { el.dataset.id = newDoc.id; });
        } catch (e) {
            updateSaveStatus('error');
            showToast('Failed to create todo', 'error');
            currentTodos = currentTodos.filter(t => t.id !== tempId);
            renderApp(currentTodos);
            console.error(e);
        }

        enterInFlight = false;
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
                currentTodos = currentTodos.filter(t => t.id !== todoId);
                dirtyIds.delete(todoId);
                renderApp(currentTodos);
                deleteTodo(uid, todoId).catch(e => { showToast('Failed to delete', 'error'); console.error(e); });
                return;
            }
            if (!prev) return;

            if (input.value === '') {
                focusTarget = { id: prev.id, cursor: prev.text.length };
                currentTodos = currentTodos.filter(t => t.id !== todoId);
                dirtyIds.delete(todoId);
                renderApp(currentTodos);
                deleteTodo(uid, todoId).catch(e => { showToast('Failed to delete', 'error'); console.error(e); });
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
                deleteTodo(uid, todoId).catch(e => { showToast('Failed to delete', 'error'); console.error(e); });
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
        const idx = currentTodos.findIndex(t => t.id === id);
        if (idx !== -1) currentTodos[idx] = { ...currentTodos[idx], text: input.value };
        dirtyIds.add(id);
        scheduleSave(id, input);
    });

    attachBlurSave(input);
    attachKeyboard(
        input, uid,
        () => currentTodos.filter(t => t.dateEpochDay === dateEpoch),
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

// --- Row create / update (flat) ---

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
        const idx = currentTodos.findIndex(t => t.id === id);
        if (idx !== -1) currentTodos[idx] = { ...currentTodos[idx], text: input.value };
        dirtyIds.add(id);
        scheduleSave(id, input);
        autoGrow();
    });

    attachBlurSave(input);
    attachKeyboard(
        input, uid,
        () => currentTodos.filter(t => t.page === currentPage),
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

function createToggleCaret(todo, uid) {
    const caret = document.createElement('div');
    caret.className = `toggle-caret${todo.collapsed ? ' closed' : ''}`;
    caret.textContent = '▼';
    caret.addEventListener('click', () => {
        const idx = currentTodos.findIndex(t => t.id === todo.id);
        if (idx === -1) return;
        const newCollapsed = !currentTodos[idx].collapsed;
        currentTodos[idx] = { ...currentTodos[idx], collapsed: newCollapsed };

        // Expanding an empty toggle: give it a first, empty child to type into right away
        if (!newCollapsed && !currentTodos.some(t => t.parentId === todo.id)) {
            const tempId = '_pending_' + Date.now();
            const newSortOrder = Date.now();
            currentTodos = [
                ...currentTodos.slice(0, idx + 1),
                { id: tempId, text: '', isDone: false, dateEpochDay: 0, sortOrder: newSortOrder, moveCount: 0, page: currentPage, parentId: todo.id },
                ...currentTodos.slice(idx + 1),
            ];
            focusTarget = { id: tempId, cursor: 'start' };
            renderApp(currentTodos);
            setCollapsed(uid, todo.id, false).catch(e => console.error(e));
            addTodo(uid, 0, '', newSortOrder, currentPage, todo.id)
                .then(newDoc => {
                    currentTodos = currentTodos.map(t => t.id === tempId ? { ...t, id: newDoc.id } : t);
                    document.querySelectorAll(`[data-id="${tempId}"]`).forEach(el => { el.dataset.id = newDoc.id; });
                })
                .catch(e => { showToast('Failed to create item', 'error'); console.error(e); });
            return;
        }

        renderApp(currentTodos);
        setCollapsed(uid, todo.id, newCollapsed).catch(e => console.error(e));
    });
    return caret;
}

// --- Row create / update (Notes: contenteditable, so bold/italic/underline can be applied) ---

function createNoteRow(todo, uid) {
    const row = document.createElement('div');
    row.className = `todo-row${todo.isDone ? ' done' : ''}`;
    row.dataset.id = todo.id;
    row.style.paddingLeft = `${(flatDepthMap.get(todo.id) || 0) * 20}px`;

    const plusBtn = document.createElement('div');
    plusBtn.className = 'row-plus-btn';
    plusBtn.innerHTML = '+';
    plusBtn.addEventListener('click', (e) => openRowMenu(e, todo, uid));
    row.appendChild(plusBtn);

    if (todo.isToggle) {
        row.appendChild(createToggleCaret(todo, uid));
    }

    const input = document.createElement('div');
    input.dataset.id = todo.id;
    input.className = `todo-input${todo.isDone ? ' done' : ''}`;
    input.contentEditable = 'true';
    input.innerHTML = todo.text;

    input.addEventListener('input', () => {
        const id = input.dataset.id;
        const idx = currentTodos.findIndex(t => t.id === id);
        if (idx !== -1) currentTodos[idx] = { ...currentTodos[idx], text: input.innerHTML };
        dirtyIds.add(id);
        scheduleSave(id, input);
    });

    // Force plain-text paste — formatting only ever comes from our own bold/italic/underline toolbar
    input.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text/plain');
        document.execCommand('insertText', false, text);
    });

    attachBlurSave(input);
    attachNoteKeyboard(input, uid, todo);

    row.appendChild(input);
    return row;
}

function updateNoteRow(row, todo, uid) {
    row.classList.toggle('done', todo.isDone);
    row.style.paddingLeft = `${(flatDepthMap.get(todo.id) || 0) * 20}px`;

    let caret = row.querySelector('.toggle-caret');
    if (todo.isToggle) {
        if (!caret) {
            caret = createToggleCaret(todo, uid);
            row.querySelector('.row-plus-btn').after(caret);
        } else {
            caret.classList.toggle('closed', !!todo.collapsed);
        }
    } else if (caret) {
        caret.remove();
    }

    const input = row.querySelector('.todo-input');
    input.classList.toggle('done', todo.isDone);

    if (document.activeElement !== input && !dirtyIds.has(todo.id)) {
        if (input.innerHTML !== todo.text) input.innerHTML = todo.text;
    }
}

// --- Contenteditable cursor helpers (Notes) ---

function isCursorAtStart(el) {
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer)) return false;
    const preRange = document.createRange();
    preRange.selectNodeContents(el);
    preRange.setEnd(range.startContainer, range.startOffset);
    return preRange.toString().length === 0;
}

function isCursorAtEnd(el) {
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer)) return false;
    const postRange = document.createRange();
    postRange.selectNodeContents(el);
    postRange.setStart(range.startContainer, range.startOffset);
    return postRange.toString().length === 0;
}

function placeCaretAtStart(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}

function placeCaretAtEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}

// Splits el's content at the current cursor position: mutates el down to the "before" half
// (removing everything after the cursor) and returns both halves as HTML strings.
function splitContentEditableAtCursor(el) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return { before: el.innerHTML, after: '' };
    const range = sel.getRangeAt(0);
    const afterRange = range.cloneRange();
    afterRange.selectNodeContents(el);
    afterRange.setStart(range.endContainer, range.endOffset);
    const afterFragment = afterRange.extractContents();
    const before = el.innerHTML;
    const tempDiv = document.createElement('div');
    tempDiv.appendChild(afterFragment);
    return { before, after: tempDiv.innerHTML };
}

// Enter/Backspace/Arrow handling for Notes rows — kept separate from attachKeyboard since
// contenteditable has no .value/.selectionStart and Notes alone has toggle children to manage.
function attachNoteKeyboard(input, uid, todo) {
    let enterInFlight = false;

    const getSiblings = () => currentTodos
        .filter(t => t.page === currentPage && (t.parentId || null) === (todo.parentId || null))
        .sort((a, b) => a.sortOrder - b.sortOrder);

    const onEnter = async (e) => {
        e.preventDefault();
        if (enterInFlight) return;
        enterInFlight = true;

        const todoId = input.dataset.id;
        const idx = currentTodos.findIndex(t => t.id === todoId);
        const current = currentTodos[idx];
        const { before, after } = splitContentEditableAtCursor(input);

        // Enter on a toggle's own header creates its first/next child; anywhere else creates a sibling
        const isChildInsert = current.isToggle;
        const insertSiblings = isChildInsert
            ? currentTodos.filter(t => t.page === currentPage && t.parentId === current.id).sort((a, b) => a.sortOrder - b.sortOrder)
            : getSiblings();
        const sibIdx = insertSiblings.findIndex(t => t.id === todoId);
        const nextSib = insertSiblings[sibIdx + 1];
        const currentOrder = current.sortOrder;
        const nextOrder = nextSib ? nextSib.sortOrder : currentOrder + 2000;
        const newSortOrder = (currentOrder + nextOrder) / 2;
        const parentId = isChildInsert ? current.id : (current.parentId || null);

        currentTodos[idx] = { ...current, text: before };
        dirtyIds.add(todoId);

        if (isChildInsert && current.collapsed) {
            currentTodos[idx] = { ...currentTodos[idx], collapsed: false };
            setCollapsed(uid, todoId, false).catch(err => console.error(err));
        }

        const tempId = '_pending_' + Date.now();
        currentTodos = [
            ...currentTodos.slice(0, idx + 1),
            { id: tempId, text: after, isDone: false, dateEpochDay: 0, sortOrder: newSortOrder, moveCount: 0, page: currentPage, parentId },
            ...currentTodos.slice(idx + 1),
        ];
        focusTarget = { id: tempId, cursor: 'start' };
        renderApp(currentTodos);

        try {
            updateSaveStatus('saving');
            const newDoc = await addTodo(uid, 0, after, newSortOrder, currentPage, parentId);
            updateSaveStatus('idle');
            currentTodos = currentTodos.map(t => t.id === tempId ? { ...t, id: newDoc.id } : t);
            if (dirtyIds.has(tempId)) { dirtyIds.delete(tempId); dirtyIds.add(newDoc.id); }
            document.querySelectorAll(`[data-id="${tempId}"]`).forEach(el => { el.dataset.id = newDoc.id; });
        } catch (err) {
            updateSaveStatus('error');
            showToast('Failed to create todo', 'error');
            currentTodos = currentTodos.filter(t => t.id !== tempId);
            renderApp(currentTodos);
            console.error(err);
        }

        enterInFlight = false;
    };

    // beforeinput is the reliable way to catch Enter in contenteditable on Android (mirrors the
    // keypress fallback attachKeyboard uses for the same reason on textareas)
    input.addEventListener('beforeinput', (e) => {
        if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') onEnter(e);
    });
    input.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') { await onEnter(e); return; }

        const todoId = input.dataset.id;

        if (e.key === 'Backspace' && isCursorAtStart(input)) {
            e.preventDefault();
            const siblings = getSiblings();
            const sibIdx = siblings.findIndex(t => t.id === todoId);
            const prev = siblings[sibIdx - 1];

            if (!prev && input.textContent === '') {
                promoteChildren(uid, todoId);
                currentTodos = currentTodos.filter(t => t.id !== todoId);
                dirtyIds.delete(todoId);
                renderApp(currentTodos);
                deleteTodo(uid, todoId).catch(err => { showToast('Failed to delete', 'error'); console.error(err); });
                return;
            }
            if (!prev) return;

            if (input.textContent === '') {
                focusTarget = { id: prev.id, cursor: 'end' };
                promoteChildren(uid, todoId);
                currentTodos = currentTodos.filter(t => t.id !== todoId);
                dirtyIds.delete(todoId);
                renderApp(currentTodos);
                deleteTodo(uid, todoId).catch(err => { showToast('Failed to delete', 'error'); console.error(err); });
            } else {
                const prevIdx = currentTodos.findIndex(t => t.id === prev.id);
                currentTodos[prevIdx] = { ...currentTodos[prevIdx], text: prev.text + input.innerHTML };
                dirtyIds.add(prev.id);
                promoteChildren(uid, todoId);
                currentTodos = currentTodos.filter(t => t.id !== todoId);
                dirtyIds.delete(todoId);
                focusTarget = { id: prev.id, cursor: 'end' };
                renderApp(currentTodos);
                deleteTodo(uid, todoId).catch(err => { showToast('Failed to delete', 'error'); console.error(err); });
            }
            return;
        }

        if (e.key === 'ArrowUp' && isCursorAtStart(input)) {
            e.preventDefault();
            const siblings = getSiblings();
            const prev = siblings[siblings.findIndex(t => t.id === todoId) - 1];
            if (prev) {
                const el = document.querySelector(`.todo-input[data-id="${prev.id}"]`);
                if (el) { el.focus(); placeCaretAtEnd(el); }
            }
        }

        if (e.key === 'ArrowDown' && isCursorAtEnd(input)) {
            e.preventDefault();
            const siblings = getSiblings();
            const next = siblings[siblings.findIndex(t => t.id === todoId) + 1];
            if (next) {
                const el = document.querySelector(`.todo-input[data-id="${next.id}"]`);
                if (el) { el.focus(); placeCaretAtStart(el); }
            }
        }
    });
}

// --- Selection format toolbar (Notes: bold / italic / underline) ---

let formatToolbarEl = null;

function hideFormatToolbar() {
    if (formatToolbarEl) { formatToolbarEl.remove(); formatToolbarEl = null; }
}

function showFormatToolbar(rect) {
    hideFormatToolbar();
    const bar = document.createElement('div');
    bar.className = 'format-toolbar';

    [['bold', 'B'], ['italic', 'I'], ['underline', 'U']].forEach(([cmd, label]) => {
        const btn = document.createElement('div');
        btn.className = `format-btn format-${cmd}`;
        btn.textContent = label;
        // Keep the text selection alive through the tap so execCommand has something to act on
        btn.addEventListener('pointerdown', (e) => e.preventDefault());
        btn.addEventListener('click', () => {
            const active = document.activeElement;
            document.execCommand(cmd);
            active?.dispatchEvent(new Event('input', { bubbles: true }));
        });
        bar.appendChild(btn);
    });

    document.body.appendChild(bar);
    const top = rect.top - bar.offsetHeight - 8;
    const left = rect.left + rect.width / 2 - bar.offsetWidth / 2;
    bar.style.top = `${Math.max(4, top)}px`;
    bar.style.left = `${Math.max(4, left)}px`;
    formatToolbarEl = bar;
}

document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hideFormatToolbar(); return; }
    const anchor = sel.anchorNode;
    const anchorEl = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
    const el = anchorEl?.closest?.('.todo-input[contenteditable="true"]');
    if (!el) { hideFormatToolbar(); return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { hideFormatToolbar(); return; }
    showFormatToolbar(rect);
});

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
        if (el) {
            el.focus();
            if (el.isContentEditable) {
                if (focusTarget.cursor === 'end') placeCaretAtEnd(el); else placeCaretAtStart(el);
            } else {
                el.setSelectionRange(focusTarget.cursor, focusTarget.cursor);
            }
        }
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

    if (isOpen) list.appendChild(buildAddBtn(dayTodos.length === 0, t('no_tasks'), () => addTodo(uid, dateEpoch).catch(e => { showToast('Failed to create todo', 'error'); console.error(e); })));

    section.appendChild(list);
    return section;
}

function reconcileDaySection(section, dateEpoch, today, dayTodos, uid) {
    const isPast = dateEpoch < today;
    const isToday = dateEpoch === today;
    const isOpen = expandedStates[dateEpoch] ?? !isPast;

    const weekdayEl = section.querySelector('.weekday');
    if (weekdayEl) weekdayEl.textContent = getDayName(dateEpoch);
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
        addBtn = buildAddBtn(dayTodos.length === 0, t('no_tasks'), () => addTodo(uid, dateEpoch).catch(e => { showToast('Failed to create todo', 'error'); console.error(e); }));
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

// Maps todo id → nesting depth for the current render pass, populated by flattenForDisplay().
// Only keepInMind actually nests; other flat pages get depth 0 for every row.
let flatDepthMap = new Map();

function flattenForDisplay(pageTodos) {
    flatDepthMap = new Map();

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

function reconcileFlatView(container, todos, uid) {
    container.querySelectorAll('.day-section').forEach(s => s.remove());

    const pageTodos = todos.filter(t => t.page === currentPage);
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
        addBtn = buildAddBtn(pageTodos.length === 0, t('no_items'), () => addTodo(uid, 0, '', Date.now(), currentPage).catch(e => { showToast('Failed to create item', 'error'); console.error(e); }));
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

// --- Row menu (Notes: "+" button) ---

let openMenuEl = null;

function closeRowMenu() {
    if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; }
}

function openRowMenu(e, todo, uid) {
    e.stopPropagation();
    closeRowMenu();

    const menu = document.createElement('div');
    menu.className = 'row-menu';

    const toggleOpt = document.createElement('div');
    toggleOpt.className = 'row-menu-item';
    toggleOpt.textContent = t('toggle_list');
    toggleOpt.addEventListener('click', () => {
        convertRowToToggle(todo, uid);
        closeRowMenu();
    });
    menu.appendChild(toggleOpt);

    // Append (invisible until positioned) so we can measure it — needed to flip the
    // menu upward when it's triggered from the bottom-docked mobile bar.
    document.body.appendChild(menu);
    const rect = e.currentTarget.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const top = spaceBelow >= menu.offsetHeight + 8 ? rect.bottom + 4 : rect.top - menu.offsetHeight - 4;
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${Math.max(4, top)}px`;

    openMenuEl = menu;
}

function convertRowToToggle(todo, uid) {
    const idx = currentTodos.findIndex(t => t.id === todo.id);
    if (idx === -1) return;
    currentTodos[idx] = { ...currentTodos[idx], isToggle: true, collapsed: true };
    renderApp(currentTodos);
    Promise.all([
        setIsToggle(uid, todo.id, true),
        setCollapsed(uid, todo.id, true),
    ]).catch(e => { showToast('Failed to convert', 'error'); console.error(e); });
}

document.addEventListener('pointerdown', (e) => {
    if (openMenuEl && !openMenuEl.contains(e.target) && !e.target.closest('.row-plus-btn')) closeRowMenu();
});

// --- Drag and Drop ---

function initDragAndDrop() {
    const container = document.getElementById('app-content');
    if (!container) return;

    let draggedRow = null;
    let placeholder = null;
    let startY = 0;
    let currentY = 0;
    let lastClientY = 0;
    let dragTimeout = null;
    let siblings = [];
    let draggedHeight = 0;
    let dragStartIndex = -1;
    let isDragging = false;

    container.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (currentPage === 'keepInMind') return; // Notes: no drag & drop

        const isTouch = e.pointerType === 'touch';
        const handle = e.target.closest('.drag-handle');
        const row = e.target.closest('.todo-row');

        if (!row) return;
        if (!isTouch && !handle) return;

        draggedRow = row;
        startY = e.clientY;

        const startDrag = () => {
            isDragging = true;
            if (navigator.vibrate) navigator.vibrate(50);

            placeholder = document.createElement('div');
            placeholder.className = 'drag-placeholder';
            draggedHeight = draggedRow.offsetHeight;
            placeholder.style.height = `${draggedHeight}px`;

            const list = draggedRow.parentElement;
            siblings = Array.from(list.querySelectorAll('.todo-row'));
            dragStartIndex = siblings.indexOf(draggedRow);

            draggedRow.classList.add('is-dragging');
            draggedRow.style.width = `${draggedRow.offsetWidth}px`;

            const rect = draggedRow.getBoundingClientRect();
            draggedRow.parentElement.insertBefore(placeholder, draggedRow);
            draggedRow.style.position = 'fixed';
            draggedRow.style.top = `${rect.top}px`;
            draggedRow.style.left = `${rect.left}px`;
            draggedRow.style.zIndex = '1000';
            
            container.setPointerCapture(e.pointerId);
        };

        if (isTouch && !handle) {
            dragTimeout = setTimeout(startDrag, 300);
        } else {
            startDrag();
        }
    });

    container.addEventListener('pointermove', (e) => {
        if (!draggedRow) return;

        if (!isDragging) {
            if (Math.abs(e.clientY - startY) > 10) {
                clearTimeout(dragTimeout);
                draggedRow = null;
            }
            return;
        }

        e.preventDefault();

        currentY = e.clientY - startY;
        draggedRow.style.transform = `translateY(${currentY}px)`;

        for (let i = 0; i < siblings.length; i++) {
            if (i === dragStartIndex) continue;
            const sib = siblings[i];
            const rect = sib.getBoundingClientRect();
            const mid = rect.top + rect.height / 2;

            if (e.clientY < mid) {
                if (i < dragStartIndex) sib.style.transform = `translateY(${draggedHeight}px)`;
                else sib.style.transform = '';
            } else {
                if (i > dragStartIndex) sib.style.transform = `translateY(-${draggedHeight}px)`;
                else sib.style.transform = '';
            }
        }
    });

    const endDrag = (e) => {
        clearTimeout(dragTimeout);
        if (!isDragging) {
            draggedRow = null;
            return;
        }

        try { container.releasePointerCapture(e.pointerId); } catch(err){}
        isDragging = false;

        const before = [
            ...siblings.slice(0, dragStartIndex).filter(s => !s.style.transform),
            ...siblings.slice(dragStartIndex + 1).filter(s => s.style.transform),
        ];
        const after = [
            ...siblings.slice(0, dragStartIndex).filter(s => s.style.transform),
            ...siblings.slice(dragStartIndex + 1).filter(s => !s.style.transform),
        ];
        const newIndex = before.length;

        placeholder.remove();
        draggedRow.classList.remove('is-dragging');
        draggedRow.style = '';
        siblings.forEach(s => s.style.transform = '');

        if (newIndex !== dragStartIndex) {
            const prevId = before.length > 0 ? before[before.length - 1].dataset.id : null;
            const nextId = after.length > 0 ? after[0].dataset.id : null;
            handleDrop(draggedRow.dataset.id, prevId, nextId);
        }

        draggedRow = null;
    };

    container.addEventListener('pointerup', endDrag);
    container.addEventListener('pointercancel', endDrag);

    container.addEventListener('touchmove', (e) => {
        if (!isDragging || !draggedRow) return;
        e.preventDefault();

        lastClientY = e.touches[0].clientY;
        currentY = lastClientY - startY;
        draggedRow.style.transform = `translateY(${currentY}px)`;

        for (let i = 0; i < siblings.length; i++) {
            if (i === dragStartIndex) continue;
            const sib = siblings[i];
            const rect = sib.getBoundingClientRect();
            const mid = rect.top + rect.height / 2;
            if (lastClientY < mid) {
                if (i < dragStartIndex) sib.style.transform = `translateY(${draggedHeight}px)`;
                else sib.style.transform = '';
            } else {
                if (i > dragStartIndex) sib.style.transform = `translateY(-${draggedHeight}px)`;
                else sib.style.transform = '';
            }
        }
    }, { passive: false });

    container.addEventListener('touchend', () => {
        if (isDragging) endDrag({ pointerId: null });
    });
}

function handleDrop(draggedId, prevId, nextId) {
    const prev = currentTodos.find(t => t.id === prevId);
    const next = currentTodos.find(t => t.id === nextId);

    let newSortOrder;
    if (prev && next) {
        newSortOrder = (prev.sortOrder + next.sortOrder) / 2;
    } else if (prev) {
        newSortOrder = prev.sortOrder + 2000;
    } else if (next) {
        newSortOrder = next.sortOrder - 2000;
    } else {
        newSortOrder = Date.now();
    }

    const idx = currentTodos.findIndex(t => t.id === draggedId);
    if (idx !== -1) {
        currentTodos[idx] = { ...currentTodos[idx], sortOrder: newSortOrder };
        currentTodos.sort((a, b) => a.sortOrder - b.sortOrder);
        renderApp(currentTodos);

        const uid = auth.currentUser?.uid;
        if (uid) {
            // Protect against scheduleRender overwriting the optimistic order with a
            // stale snapshot that arrives before this write has propagated (snap-back)
            dirtyIds.add(draggedId);
            updateSaveStatus('saving');
            updateSortOrder(uid, draggedId, newSortOrder)
                .then(() => {
                    dirtyIds.delete(draggedId);
                    updateSaveStatus('idle');
                })
                .catch(e => {
                    dirtyIds.delete(draggedId);
                    showToast('Failed to save order', 'error');
                    console.error(e);
                    updateSaveStatus('error');
                });
        }
    }
}

initDragAndDrop();

// --- Mobile Notes compose bar ---
// No mouse on mobile, so the per-row "+" (hover-only on desktop) doesn't work there.
// Instead, dock a "+" above the keyboard while a Notes input is focused — best effort via
// VisualViewport, since fixed-position elements don't naturally follow the keyboard on iOS.
function initMobileNotesBar() {
    let bar = null;
    let focusedNoteId = null;

    const isMobile = () => window.matchMedia('(max-width: 768px)').matches;

    function ensureBar() {
        if (bar) return bar;
        bar = document.createElement('div');
        bar.className = 'mobile-notes-bar';
        const btn = document.createElement('div');
        btn.className = 'mobile-notes-bar-btn';
        btn.textContent = '+';
        // Keep the input focused (and keyboard open) through the tap
        btn.addEventListener('pointerdown', (e) => e.preventDefault());
        btn.addEventListener('click', (e) => {
            const todo = currentTodos.find(t => t.id === focusedNoteId);
            const uid = auth.currentUser?.uid;
            if (todo && uid) openRowMenu({ currentTarget: e.currentTarget, stopPropagation() {} }, todo, uid);
        });
        bar.appendChild(btn);
        document.body.appendChild(bar);
        return bar;
    }

    function reposition() {
        if (!bar || !bar.classList.contains('visible') || !window.visualViewport) return;
        const vv = window.visualViewport;
        const offsetFromBottom = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
        bar.style.bottom = `${offsetFromBottom}px`;
    }

    document.addEventListener('focusin', (e) => {
        if (!isMobile() || currentPage !== 'keepInMind' || !e.target.classList.contains('todo-input')) return;
        focusedNoteId = e.target.dataset.id;
        ensureBar().classList.add('visible');
        reposition();
    });

    document.addEventListener('focusout', (e) => {
        if (!e.target.classList.contains('todo-input')) return;
        setTimeout(() => {
            if (!document.activeElement?.classList.contains('todo-input')) {
                bar?.classList.remove('visible');
                focusedNoteId = null;
            }
        }, 50);
    });

    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', reposition);
        window.visualViewport.addEventListener('scroll', reposition);
    }
}

initMobileNotesBar();

// Cancel typing animation on any user interaction so the UI stays fully responsive
document.addEventListener('pointerdown', () => {
    if (isAnimating) cancelTypingAnimation();
}, { capture: true });
