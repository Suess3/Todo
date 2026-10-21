// Pointer-based drag & drop reordering for todo/soon/longRun — deliberately not
// for Notes, so that page keeps feeling like a notes app rather than a todo list.
// Long-press (300ms) starts the drag on touch; the ⋮⋮ handle on desktop.
// On the calendar a row can also be dropped onto another day (today or later),
// and the page scrolls along when the pointer nears the top or bottom edge.

import { auth } from './firebase.js';
import { updateSortOrder, moveTodoToDay, getTodayEpoch } from './todoService.js';
import { todos, dirtyIds, currentPage, rerender } from './store.js';
import { t } from './i18n.js';
import { updateSaveStatus, showToast } from './feedback.js';
import { recordReorder, recordDayMove } from './history.js';

function initDragAndDrop() {
    const container = document.getElementById('app-content');
    if (!container) return;

    let draggedRow = null;
    let placeholder = null;
    let startY = 0;
    let currentY = 0;
    let lastClientX = 0;
    let lastClientY = 0;
    let dragTimeout = null;
    let siblings = [];
    let draggedHeight = 0;
    let dragStartIndex = -1;
    let isDragging = false;
    // Cross-day drop target on the calendar: { section, epoch, beforeRow } or null
    let dayTarget = null;
    let indicator = null;
    let scrollFrame = null;

    container.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (currentPage === 'keepInMind') return;

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
            lastClientX = e.clientX;
            lastClientY = e.clientY;
            scrollFrame = requestAnimationFrame(autoScroll);
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
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        updateDrag();
    });

    // Shared by pointermove, touchmove and the auto-scroll loop (scrolling moves
    // the rows under a pointer that itself stands still)
    function updateDrag() {
        currentY = lastClientY - startY;
        draggedRow.style.transform = `translateY(${currentY}px)`;

        dayTarget = findDayTarget();
        updateIndicator();
        if (dayTarget) {
            // Hovering another day: the own list closes its gaps again (siblings
            // includes the dragged row itself, which has to keep following the pointer)
            siblings.forEach(s => { if (s !== draggedRow) s.style.transform = ''; });
            return;
        }

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
    }

    // The dragged row has pointer-events: none, so elementFromPoint sees what's under it
    function findDayTarget() {
        if (currentPage !== 'todo') return null;
        const section = document.elementFromPoint(lastClientX, lastClientY)?.closest('.day-section');
        const ownSection = draggedRow.closest('.day-section');
        if (!section || section === ownSection) return null;
        const epoch = Number(section.dataset.epoch);
        // Yesterday would be carried straight back to today by moveTodos
        if (epoch < getTodayEpoch()) return null;
        const list = section.querySelector('.todo-list');
        if (list.classList.contains('hidden')) return { section, epoch, beforeRow: null };
        const rows = [...list.querySelectorAll('.todo-row')];
        const beforeRow = rows.find(r => {
            const rect = r.getBoundingClientRect();
            return lastClientY < rect.top + rect.height / 2;
        }) || null;
        return { section, epoch, beforeRow };
    }

    function updateIndicator() {
        document.querySelectorAll('.day-header.drop-target').forEach(h => {
            if (h.parentElement !== dayTarget?.section) h.classList.remove('drop-target');
        });
        if (!dayTarget) { indicator?.remove(); return; }
        dayTarget.section.querySelector('.day-header').classList.add('drop-target');
        const list = dayTarget.section.querySelector('.todo-list');
        if (list.classList.contains('hidden')) { indicator?.remove(); return; }
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.className = 'drop-indicator';
        }
        const anchor = dayTarget.beforeRow || list.querySelector('.tap-to-add');
        if (indicator.parentNode !== list || indicator.nextSibling !== anchor) list.insertBefore(indicator, anchor);
    }

    function clearDayTarget() {
        indicator?.remove();
        document.querySelectorAll('.day-header.drop-target').forEach(h => h.classList.remove('drop-target'));
        dayTarget = null;
    }

    const EDGE = 60;
    const MAX_SPEED = 18;

    function autoScroll() {
        if (!isDragging) return;
        const fromTop = lastClientY;
        const fromBottom = window.innerHeight - lastClientY;
        let speed = 0;
        if (fromTop < EDGE) speed = -MAX_SPEED * (1 - fromTop / EDGE);
        else if (fromBottom < EDGE) speed = MAX_SPEED * (1 - fromBottom / EDGE);
        if (speed) {
            const before = window.scrollY;
            window.scrollBy(0, speed);
            // The row is position: fixed — shift its origin so it stays under the pointer
            if (window.scrollY !== before) updateDrag();
        }
        scrollFrame = requestAnimationFrame(autoScroll);
    }

    const endDrag = (e) => {
        clearTimeout(dragTimeout);
        if (!isDragging) {
            draggedRow = null;
            return;
        }

        try { container.releasePointerCapture(e.pointerId); } catch (err) {}
        isDragging = false;
        cancelAnimationFrame(scrollFrame);

        const target = dayTarget;
        clearDayTarget();
        if (target) {
            const targetRows = [...target.section.querySelectorAll('.todo-list .todo-row')];
            const beforeIdx = target.beforeRow ? targetRows.indexOf(target.beforeRow) : targetRows.length;
            const prevId = targetRows[beforeIdx - 1]?.dataset.id ?? null;
            const nextId = targetRows[beforeIdx]?.dataset.id ?? null;
            placeholder.remove();
            draggedRow.classList.remove('is-dragging');
            draggedRow.style = '';
            siblings.forEach(s => s.style.transform = '');
            handleDayDrop(draggedRow.dataset.id, target.epoch, prevId, nextId);
            draggedRow = null;
            return;
        }

        // Read the drop position from the siblings' transform state rather than
        // getBoundingClientRect — the 0.2s transform transition makes the visual
        // position unreliable at drop time.
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

    // touchmove with preventDefault stops the browser from firing pointercancel
    // (which would abort the drag) — and since that also suppresses the synthesized
    // pointermove events, position tracking has to happen here.
    container.addEventListener('touchmove', (e) => {
        if (!isDragging || !draggedRow) return;
        e.preventDefault();

        lastClientX = e.touches[0].clientX;
        lastClientY = e.touches[0].clientY;
        updateDrag();
    }, { passive: false });

    container.addEventListener('touchend', () => {
        if (isDragging) endDrag({ pointerId: null });
    });
}

function sortOrderBetween(prevId, nextId) {
    const prev = todos.find(t => t.id === prevId);
    const next = todos.find(t => t.id === nextId);
    if (prev && next) return (prev.sortOrder + next.sortOrder) / 2;
    if (prev) return prev.sortOrder + 2000;
    if (next) return next.sortOrder - 2000;
    return Date.now();
}

// moveCount is kept on purpose: pushing a todo to a later day is still postponing it
function handleDayDrop(draggedId, epoch, prevId, nextId) {
    const idx = todos.findIndex(t => t.id === draggedId);
    if (idx === -1 || draggedId.startsWith('_pending_')) return;
    const newSortOrder = sortOrderBetween(prevId, nextId);
    recordDayMove(draggedId, todos[idx].dateEpochDay, todos[idx].sortOrder);
    todos[idx] = { ...todos[idx], dateEpochDay: epoch, sortOrder: newSortOrder };
    todos.sort((a, b) => a.sortOrder - b.sortOrder);
    rerender(todos);

    const uid = auth.currentUser?.uid;
    if (!uid) return;
    // Same snap-back guard as a reorder
    dirtyIds.add(draggedId);
    updateSaveStatus('saving');
    moveTodoToDay(uid, draggedId, epoch, newSortOrder)
        .then(() => {
            dirtyIds.delete(draggedId);
            updateSaveStatus('idle');
        })
        .catch(e => {
            dirtyIds.delete(draggedId);
            showToast(t('err_save_order'), 'error');
            console.error(e);
            updateSaveStatus('error');
        });
}

function handleDrop(draggedId, prevId, nextId) {
    const newSortOrder = sortOrderBetween(prevId, nextId);

    const idx = todos.findIndex(t => t.id === draggedId);
    if (idx !== -1) {
        recordReorder(draggedId, todos[idx].sortOrder);
        todos[idx] = { ...todos[idx], sortOrder: newSortOrder };
        todos.sort((a, b) => a.sortOrder - b.sortOrder);
        rerender(todos);

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
                    showToast(t('err_save_order'), 'error');
                    console.error(e);
                    updateSaveStatus('error');
                });
        }
    }
}

initDragAndDrop();
