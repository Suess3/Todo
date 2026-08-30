// Pointer-based drag & drop reordering for todo/soon/longRun — deliberately not
// for Notes, so that page keeps feeling like a notes app rather than a todo list.
// Long-press (300ms) starts the drag on touch; the ⋮⋮ handle on desktop.

import { auth } from './firebase.js';
import { updateSortOrder } from './todoService.js';
import { todos, dirtyIds, currentPage, rerender } from './store.js';
import { updateSaveStatus, showToast } from './feedback.js';
import { recordReorder } from './history.js';

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

        try { container.releasePointerCapture(e.pointerId); } catch (err) {}
        isDragging = false;

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
    const prev = todos.find(t => t.id === prevId);
    const next = todos.find(t => t.id === nextId);

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
                    showToast('Failed to save order', 'error');
                    console.error(e);
                    updateSaveStatus('error');
                });
        }
    }
}

initDragAndDrop();
