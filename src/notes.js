// Everything specific to the Notes page (keepInMind): contenteditable rows,
// the HTML sanitizer, toggle lists, the format toolbar and the mobile bar.
// Kept separate from the textarea-based rows in render.js on purpose —
// contenteditable has no .value/.selectionStart, everything goes through the
// Selection/Range API, and only Notes has toggle children to manage.

import { auth } from './firebase.js';
import { addTodo, deleteTodo, setIsToggle, setCollapsed, setParent } from './todoService.js';
import { todos, setTodos, dirtyIds, currentPage, setFocusTarget, flatDepthMap, rerender } from './store.js';
import { showToast } from './feedback.js';
import { scheduleSave, attachBlurSave, commitTempTodo } from './save.js';
import { recordChange } from './history.js';
import { t } from './i18n.js';

export function isMobileViewport() {
    return window.matchMedia('(max-width: 768px)').matches;
}

// --- HTML sanitizer ---

// Notes store their rich text as an HTML snippet, so anything in Firestore ends up in
// innerHTML. The security rules only let an account write its own docs, but a snippet
// written around the app (e.g. straight through the Firestore API) must still never
// execute here — strip everything except the formatting our own toolbar can produce.
const NOTE_ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'BR', 'FONT', 'SPAN']);
// execCommand('foreColor') emits <font color="…"> or <span style="color:…"> depending
// on the browser; only plain color values pass, nothing url()- or expression-shaped
const NOTE_COLOR_VALUE = /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s%]+\)|[a-z]+)$/i;
const NOTE_STYLE_COLOR = /^color:\s*([^;]+);?\s*$/i;

export function sanitizeNoteHtml(html) {
    const tmpl = document.createElement('template');
    tmpl.innerHTML = html;

    (function clean(parent) {
        for (const el of [...parent.children]) {
            clean(el);
            if (!NOTE_ALLOWED_TAGS.has(el.tagName)) {
                el.replaceWith(...el.childNodes); // keep the text, drop the tag
                continue;
            }
            for (const attr of [...el.attributes]) {
                const v = attr.value.trim();
                const keep =
                    (el.tagName === 'FONT' && attr.name === 'color' && NOTE_COLOR_VALUE.test(v)) ||
                    (el.tagName === 'SPAN' && attr.name === 'style' &&
                        NOTE_STYLE_COLOR.test(v) && NOTE_COLOR_VALUE.test(v.match(NOTE_STYLE_COLOR)[1].trim()));
                if (!keep) el.removeAttribute(attr.name);
            }
        }
    })(tmpl.content);

    return tmpl.innerHTML;
}

// --- Contenteditable cursor helpers ---

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

export function placeCaretAtStart(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}

export function placeCaretAtEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}

// Places the caret at a plain-text character offset, walking text nodes so it lands correctly
// regardless of any <b>/<i>/<u> tags in between.
export function placeCaretAtTextOffset(el, offset) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let remaining = offset;
    let node = walker.nextNode();
    while (node) {
        if (remaining <= node.textContent.length) {
            const range = document.createRange();
            range.setStart(node, remaining);
            range.collapse(true);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            return;
        }
        remaining -= node.textContent.length;
        node = walker.nextNode();
    }
    placeCaretAtEnd(el);
}

// Visible-character length of an HTML snippet, ignoring tags — used to find the exact join
// point when merging two notes so the cursor can land there instead of at the very end.
// Parsed inside a <template>: its content is inert, so nothing in the snippet can load or run.
function plainTextLength(html) {
    const tmpl = document.createElement('template');
    tmpl.innerHTML = html;
    return tmpl.content.textContent.length;
}

// Splits el's content at the current cursor position into "before"/"after" HTML strings, via
// cloning rather than mutating the live element — extractContents() forces a synchronous reflow
// on el right before the reconcile a moment later triggers another one, which is the "bump" felt
// on Enter. Cloning into detached (never-attached) divs costs nothing layout-wise.
function splitContentEditableAtCursor(el) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return { before: el.innerHTML, after: '' };
    const range = sel.getRangeAt(0);

    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(el);
    beforeRange.setEnd(range.endContainer, range.endOffset);
    const beforeDiv = document.createElement('div');
    beforeDiv.appendChild(beforeRange.cloneContents());

    const afterRange = document.createRange();
    afterRange.selectNodeContents(el);
    afterRange.setStart(range.endContainer, range.endOffset);
    const afterDiv = document.createElement('div');
    afterDiv.appendChild(afterRange.cloneContents());

    return { before: beforeDiv.innerHTML, after: afterDiv.innerHTML };
}

// --- Toggle helpers ---

// Deleting a toggle shouldn't orphan its children — reparent them to the toggle's own parent first.
// Lifts a row's children one level before it disappears, so nothing is orphaned.
// Returns what it changed ({ id, previousParentId }) so undo can hang them back.
export function promoteChildren(uid, todoId) {
    const children = todos.filter(t => t.parentId === todoId);
    if (children.length === 0) return [];
    const deleted = todos.find(t => t.id === todoId);
    const newParentId = deleted?.parentId || null;
    setTodos(todos.map(t => t.parentId === todoId ? { ...t, parentId: newParentId } : t));
    children.forEach(c => setParent(uid, c.id, newParentId).catch(e => console.error(e)));
    return children.map(c => ({ id: c.id, previousParentId: todoId }));
}

function createToggleCaret(todo, uid) {
    const caret = document.createElement('div');
    caret.className = `toggle-caret${todo.collapsed ? ' closed' : ''}`;
    caret.textContent = '▼';
    caret.addEventListener('click', () => {
        // Read the id from the row at click time — the captured `todo` goes stale after
        // the temp→real id swap on Enter-created rows (same pattern as createCheckbox)
        const id = caret.closest('.todo-row')?.dataset.id;
        if (!id || id.startsWith('_pending_')) return;
        const idx = todos.findIndex(t => t.id === id);
        if (idx === -1) return;
        const newCollapsed = !todos[idx].collapsed;
        todos[idx] = { ...todos[idx], collapsed: newCollapsed };

        // Expanding an empty toggle: give it a first, empty child to type into right away
        if (!newCollapsed && !todos.some(t => t.parentId === id)) {
            const tempId = '_pending_' + Date.now();
            const newSortOrder = Date.now();
            setTodos([
                ...todos.slice(0, idx + 1),
                { id: tempId, text: '', isDone: false, dateEpochDay: 0, sortOrder: newSortOrder, moveCount: 0, page: currentPage, parentId: id },
                ...todos.slice(idx + 1),
            ]);
            setFocusTarget({ id: tempId, cursor: 'start' });
            rerender(todos);
            setCollapsed(uid, id, false).catch(e => console.error(e));
            commitTempTodo(tempId, addTodo(uid, 0, '', newSortOrder, currentPage, id), 'Failed to create item');
            return;
        }

        rerender(todos);
        setCollapsed(uid, id, newCollapsed).catch(e => console.error(e));
    });
    return caret;
}

// --- Row create / update (contenteditable, so bold/italic/underline can be applied) ---

export function createNoteRow(todo, uid) {
    const row = document.createElement('div');
    row.className = `todo-row${todo.isDone ? ' done' : ''}`;
    row.dataset.id = todo.id;
    row.style.paddingLeft = `${(flatDepthMap.get(todo.id) || 0) * 20}px`;

    const plusBtn = document.createElement('div');
    plusBtn.className = 'row-plus-btn';
    plusBtn.innerHTML = '+';
    // Look the todo up at click time — the captured `todo` goes stale after the temp→real
    // id swap on Enter-created rows (same pattern as createCheckbox)
    plusBtn.addEventListener('click', (e) => {
        const id = row.dataset.id;
        if (id.startsWith('_pending_')) return;
        const current = todos.find(t => t.id === id);
        if (current) openRowMenu(e, current, uid);
    });
    row.appendChild(plusBtn);

    if (todo.isToggle) {
        row.appendChild(createToggleCaret(todo, uid));
    }

    const input = document.createElement('div');
    input.dataset.id = todo.id;
    input.className = `todo-input${todo.isDone ? ' done' : ''}`;
    input.contentEditable = 'true';
    input.innerHTML = sanitizeNoteHtml(todo.text);

    input.addEventListener('input', () => {
        const id = input.dataset.id;
        const idx = todos.findIndex(t => t.id === id);
        if (idx !== -1) todos[idx] = { ...todos[idx], text: input.innerHTML };
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
    attachNoteKeyboard(input, uid);

    row.appendChild(input);
    return row;
}

export function updateNoteRow(row, todo, uid) {
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
        // Compare against the sanitized form — comparing raw todo.text would re-write
        // (and re-sanitize) the node on every render whenever the two differ
        const safe = sanitizeNoteHtml(todo.text);
        if (input.innerHTML !== safe) input.innerHTML = safe;
    }
}

// --- Keyboard (Enter/Backspace/Arrows) ---

function attachNoteKeyboard(input, uid) {
    let enterInFlight = false;

    // Resolved at event time via input.dataset.id — a todo captured at attach time would go
    // stale after the temp→real id swap or a later toggle conversion / reparent
    const getSiblings = () => {
        const self = todos.find(t => t.id === input.dataset.id);
        const parentKey = self ? (self.parentId || null) : null;
        return todos
            .filter(t => t.page === currentPage && (t.parentId || null) === parentKey)
            .sort((a, b) => a.sortOrder - b.sortOrder);
    };

    const onEnter = async (e) => {
        e.preventDefault();
        if (enterInFlight) return;
        enterInFlight = true;

        // Wrapped in try/finally so any unexpected error (e.g. todoId no longer present in
        // todos) can never leave enterInFlight stuck true — which would silently make
        // Enter a no-op on this row forever after.
        try {
            const todoId = input.dataset.id;
            const idx = todos.findIndex(t => t.id === todoId);
            if (idx === -1) return;
            const current = todos[idx];
            const { before, after } = splitContentEditableAtCursor(input);
            const siblings = getSiblings();
            const sibIdx = siblings.findIndex(t => t.id === todoId);

            // The toggle flags have to be written before commitTempTodo swaps the temp id —
            // once the swap lands, renders are no longer suppressed and a snapshot without
            // the flags would briefly render the new row as a plain line.
            const persistWithToggleFlags = (text, sortOrder, parentId, asToggle) =>
                addTodo(uid, 0, text, sortOrder, currentPage, parentId).then(async newDoc => {
                    if (asToggle) {
                        await Promise.all([
                            setIsToggle(uid, newDoc.id, true),
                            setCollapsed(uid, newDoc.id, true),
                        ]).catch(err => console.error(err));
                    }
                    return newDoc;
                });

            if (before === '') {
                // Cursor was at the very start: insert an empty sibling BEFORE this row instead of
                // splitting its text off into a new row. Keeping current's id (and thus its children,
                // if it's a toggle) in place is what stops a toggle's header + children from getting
                // orphaned onto a brand new id when there's nothing to its left to begin with.
                const prevSib = siblings[sibIdx - 1];
                const currentOrder = current.sortOrder;
                const prevOrder = prevSib ? prevSib.sortOrder : currentOrder - 2000;
                const newSortOrder = (prevOrder + currentOrder) / 2;
                const parentId = current.parentId || null;

                const tempId = '_pending_' + Date.now();
                setTodos([
                    ...todos.slice(0, idx),
                    { id: tempId, text: '', isDone: false, dateEpochDay: 0, sortOrder: newSortOrder, moveCount: 0, page: currentPage, parentId, isToggle: current.isToggle, collapsed: current.isToggle ? true : false },
                    ...todos.slice(idx),
                ]);
                setFocusTarget({ id: todoId, cursor: 'start' });
                rerender(todos);
                const inserted = await commitTempTodo(tempId, persistWithToggleFlags('', newSortOrder, parentId, current.isToggle));
                if (inserted) recordChange({ created: [inserted.id] });
                return;
            }

            // Enter on an EXPANDED toggle's own header creates its first/next child. A collapsed
            // toggle has no visible children to "add to", so it's treated as a normal sibling split
            // instead — the new row inherits isToggle so splitting a toggle produces two toggles.
            const isChildInsert = current.isToggle && !current.collapsed;
            const newIsToggle = !isChildInsert && current.isToggle;
            const insertSiblings = isChildInsert
                ? todos.filter(t => t.page === currentPage && t.parentId === current.id).sort((a, b) => a.sortOrder - b.sortOrder)
                : siblings;
            const insertSibIdx = insertSiblings.findIndex(t => t.id === todoId);
            const nextSib = insertSiblings[insertSibIdx + 1];
            const currentOrder = current.sortOrder;
            const nextOrder = nextSib ? nextSib.sortOrder : currentOrder + 2000;
            const newSortOrder = (currentOrder + nextOrder) / 2;
            const parentId = isChildInsert ? current.id : (current.parentId || null);

            todos[idx] = { ...current, text: before };
            dirtyIds.add(todoId);
            // input still shows the pre-split content since splitContentEditableAtCursor doesn't
            // mutate it — write it in ourselves (the dirty flag above would otherwise make the
            // reconcile below skip it, same as the merge case)
            input.innerHTML = before;

            const tempId = '_pending_' + Date.now();
            setTodos([
                ...todos.slice(0, idx + 1),
                { id: tempId, text: after, isDone: false, dateEpochDay: 0, sortOrder: newSortOrder, moveCount: 0, page: currentPage, parentId, isToggle: newIsToggle, collapsed: newIsToggle ? true : false },
                ...todos.slice(idx + 1),
            ]);
            setFocusTarget({ id: tempId, cursor: 'start' });
            rerender(todos);
            const split = await commitTempTodo(tempId, persistWithToggleFlags(after, newSortOrder, parentId, newIsToggle));
            if (split) recordChange({ created: [split.id], textRestores: [{ id: todoId, text: current.text }] });
        } finally {
            enterInFlight = false;
        }
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

            // Backspace on an empty toggle's own header un-toggles it back to a plain empty row
            // instead of deleting the line — same idea as a block editor's block "un-typing" on delete
            const current = todos.find(t => t.id === todoId);
            if (current?.isToggle && input.textContent === '') {
                const idx = todos.findIndex(t => t.id === todoId);
                todos[idx] = { ...todos[idx], isToggle: false, collapsed: false };
                promoteChildren(uid, todoId);
                setFocusTarget({ id: todoId, cursor: 'start' });
                rerender(todos);
                Promise.all([
                    setIsToggle(uid, todoId, false),
                    setCollapsed(uid, todoId, false),
                ]).catch(err => console.error(err));
                return;
            }

            const siblings = getSiblings();
            const sibIdx = siblings.findIndex(t => t.id === todoId);
            const prev = siblings[sibIdx - 1];

            if (!prev && input.textContent === '') {
                const removed = { ...todos.find(t => t.id === todoId) };
                const reparented = promoteChildren(uid, todoId);
                recordChange({ removed: [removed], reparented });
                setTodos(todos.filter(t => t.id !== todoId));
                dirtyIds.delete(todoId);
                rerender(todos);
                deleteTodo(uid, todoId).catch(err => { showToast('Failed to delete', 'error'); console.error(err); });
                return;
            }
            if (!prev) return;

            if (input.textContent === '') {
                setFocusTarget({ id: prev.id, cursor: 'end' });
                const removed = { ...todos.find(t => t.id === todoId) };
                const reparented = promoteChildren(uid, todoId);
                recordChange({ removed: [removed], reparented });
                setTodos(todos.filter(t => t.id !== todoId));
                dirtyIds.delete(todoId);
                rerender(todos);
                deleteTodo(uid, todoId).catch(err => { showToast('Failed to delete', 'error'); console.error(err); });
            } else {
                const prevIdx = todos.findIndex(t => t.id === prev.id);
                const splitOffset = plainTextLength(prev.text);
                const mergedText = prev.text + input.innerHTML;
                todos[prevIdx] = { ...todos[prevIdx], text: mergedText };
                dirtyIds.add(prev.id);
                // Write the merge straight into prev's DOM node — the dirty flag we just set
                // would otherwise make the reconcile below skip refreshing its (already-rendered) content
                const prevEl = document.querySelector(`.todo-input[data-id="${prev.id}"]`);
                if (prevEl) prevEl.innerHTML = sanitizeNoteHtml(mergedText);
                const removed = { ...todos.find(t => t.id === todoId) };
                const reparented = promoteChildren(uid, todoId);
                recordChange({ removed: [removed], reparented, textRestores: [{ id: prev.id, text: prev.text }] });
                setTodos(todos.filter(t => t.id !== todoId));
                dirtyIds.delete(todoId);
                // Land the cursor at the join point (where the deleted line used to start),
                // not at the very end of the merged text
                setFocusTarget({ id: prev.id, cursor: splitOffset });
                rerender(todos);
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

// --- Selection format toolbar (bold / italic / underline / color, desktop only — see initMobileNotesBar) ---

// value: null means "default" (reset to the theme's normal text color)
const NOTE_COLORS = [
    { name: 'default', value: null },
    { name: 'gray', value: '#9B9A97' },
    { name: 'orange', value: '#D9730D' },
    { name: 'yellow', value: '#CB912F' },
    { name: 'green', value: '#448361' },
    { name: 'blue', value: '#337EA9' },
    { name: 'purple', value: '#9065B0' },
    { name: 'red', value: '#D44C47' },
];

function applyTextColor(color) {
    // Read from body, not documentElement — [data-theme] is set on <body>, so that's where the
    // live (theme-correct) value of --text actually resolves
    const value = color || getComputedStyle(document.body).getPropertyValue('--text').trim();
    const active = document.activeElement;
    document.execCommand('foreColor', false, value);
    active?.dispatchEvent(new Event('input', { bubbles: true }));
}

// All format-toolbar/color-swatch buttons preventDefault on mousedown — that's the event whose
// default action collapses the text selection, so keeping it alive is what lets execCommand act on it
function formatBarButton(label, className, onClick) {
    const btn = document.createElement('div');
    btn.className = className;
    btn.textContent = label;
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', onClick);
    return btn;
}

let formatToolbarEl = null;
let formatToolbarRect = null;

function hideFormatToolbar() {
    if (formatToolbarEl) { formatToolbarEl.remove(); formatToolbarEl = null; }
    formatToolbarRect = null;
}

function positionFormatToolbar(bar, rect) {
    const top = rect.top - bar.offsetHeight - 8;
    const left = rect.left + rect.width / 2 - bar.offsetWidth / 2;
    bar.style.top = `${Math.max(4, top)}px`;
    bar.style.left = `${Math.max(4, left)}px`;
}

function renderFormatToolbarMain(bar) {
    bar.innerHTML = '';
    [['bold', 'B'], ['italic', 'I'], ['underline', 'U']].forEach(([cmd, label]) => {
        bar.appendChild(formatBarButton(label, `format-btn format-${cmd}`, () => {
            const active = document.activeElement;
            document.execCommand(cmd);
            active?.dispatchEvent(new Event('input', { bubbles: true }));
        }));
    });
    bar.appendChild(formatBarButton('A', 'format-btn format-color-trigger', () => renderFormatToolbarColors(bar)));
    positionFormatToolbar(bar, formatToolbarRect);
}

function renderFormatToolbarColors(bar) {
    bar.innerHTML = '';
    bar.appendChild(formatBarButton('‹', 'format-btn', () => renderFormatToolbarMain(bar)));
    NOTE_COLORS.forEach(({ name, value }) => {
        const swatch = document.createElement('div');
        swatch.className = `format-color-swatch${value ? '' : ' is-default'}`;
        swatch.style.background = value || 'var(--text)';
        swatch.title = name;
        swatch.addEventListener('mousedown', (e) => e.preventDefault());
        swatch.addEventListener('click', () => { applyTextColor(value); hideFormatToolbar(); });
        bar.appendChild(swatch);
    });
    positionFormatToolbar(bar, formatToolbarRect);
}

function showFormatToolbar(rect) {
    hideFormatToolbar();
    const bar = document.createElement('div');
    bar.className = 'format-toolbar';
    document.body.appendChild(bar);
    formatToolbarRect = rect;
    renderFormatToolbarMain(bar);
    formatToolbarEl = bar;
}

document.addEventListener('selectionchange', () => {
    // Mobile shows bold/italic/underline in the docked bar above the keyboard instead (see initMobileNotesBar)
    if (isMobileViewport()) { hideFormatToolbar(); return; }
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

// --- Row menu ("+" button) ---

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
    const idx = todos.findIndex(t => t.id === todo.id);
    if (idx === -1) return;
    todos[idx] = { ...todos[idx], isToggle: true, collapsed: true };
    rerender(todos);
    // Same snap-back guard as drag & drop: clicking "+" blurs the input, whose save can produce
    // a snapshot that still has isToggle=false — keep it from reverting the optimistic caret
    dirtyIds.add(todo.id);
    Promise.all([
        setIsToggle(uid, todo.id, true),
        setCollapsed(uid, todo.id, true),
    ])
        .then(() => dirtyIds.delete(todo.id))
        .catch(e => { dirtyIds.delete(todo.id); showToast('Failed to convert', 'error'); console.error(e); });
}

document.addEventListener('pointerdown', (e) => {
    if (openMenuEl && !openMenuEl.contains(e.target) && !e.target.closest('.row-plus-btn')) closeRowMenu();
});

// --- Mobile compose bar ---
// No mouse on mobile, so the per-row "+" (hover-only on desktop) doesn't work there, and there's
// nowhere for a floating selection toolbar to sensibly appear above the keyboard either. Instead,
// dock a single bar above the keyboard while a Notes input is focused — best effort via
// VisualViewport, since fixed-position elements don't naturally follow the keyboard on iOS. It
// shows "+" normally, and swaps to bold/italic/underline while text is selected.
function initMobileNotesBar() {
    let bar = null;
    let focusedNoteId = null;

    // Prefer the live focused input's id — focusedNoteId can hold a temp id that was
    // swapped for the real one while the input stayed focused
    function focusedTodo() {
        const active = document.activeElement;
        const id = active?.classList?.contains('todo-input') ? active.dataset.id : focusedNoteId;
        return todos.find(t => t.id === id);
    }

    // All bar buttons preventDefault on mousedown: keeps the input focused (and the
    // keyboard open) through the tap, and any text selection alive for execCommand
    function barButton(label, className, onClick) {
        const btn = document.createElement('div');
        btn.className = className;
        btn.textContent = label;
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', onClick);
        return btn;
    }

    function buildPlusButtons() {
        return [barButton('+', 'mobile-notes-bar-btn', () => setMode('menu'))];
    }

    // The bar itself becomes the menu (Notion-style) — no popup above it
    function buildMenuButtons() {
        return [
            barButton('×', 'mobile-notes-bar-btn', () => setMode('plus')),
            barButton(t('toggle_list'), 'mobile-notes-bar-btn mobile-notes-bar-option', () => {
                const todo = focusedTodo();
                const uid = auth.currentUser?.uid;
                if (todo && uid) convertRowToToggle(todo, uid);
                setMode('plus');
            }),
        ];
    }

    function buildFormatButtons() {
        const buttons = [['bold', 'B'], ['italic', 'I'], ['underline', 'U']].map(([cmd, label]) =>
            barButton(label, `mobile-notes-bar-btn format-${cmd}`, () => {
                const active = document.activeElement;
                document.execCommand(cmd);
                active?.dispatchEvent(new Event('input', { bubbles: true }));
            })
        );
        buttons.push(barButton('A', 'mobile-notes-bar-btn format-color-trigger', () => setMode('color')));
        return buttons;
    }

    function buildColorButtons() {
        const buttons = [barButton('‹', 'mobile-notes-bar-btn', () => setMode('format'))];
        NOTE_COLORS.forEach(({ name, value }) => {
            const swatch = document.createElement('div');
            swatch.className = `mobile-notes-bar-btn mobile-color-swatch${value ? '' : ' is-default'}`;
            swatch.style.background = value || 'var(--text)';
            swatch.title = name;
            swatch.addEventListener('mousedown', (e) => e.preventDefault());
            swatch.addEventListener('click', () => { applyTextColor(value); setMode('format'); });
            buttons.push(swatch);
        });
        return buttons;
    }

    const MODE_BUILDERS = { plus: buildPlusButtons, menu: buildMenuButtons, format: buildFormatButtons, color: buildColorButtons };

    function setMode(mode) {
        if (!bar || bar.dataset.mode === mode) return;
        bar.dataset.mode = mode;
        bar.innerHTML = '';
        MODE_BUILDERS[mode]().forEach(el => bar.appendChild(el));
    }

    function ensureBar() {
        if (bar) return bar;
        bar = document.createElement('div');
        bar.className = 'mobile-notes-bar';
        document.body.appendChild(bar);
        setMode('plus');
        return bar;
    }

    function reposition() {
        if (!bar || !bar.classList.contains('visible') || !window.visualViewport) return;
        const vv = window.visualViewport;
        const offsetFromBottom = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
        bar.style.bottom = `${offsetFromBottom}px`;
    }

    document.addEventListener('focusin', (e) => {
        if (!isMobileViewport() || currentPage !== 'keepInMind' || !e.target.classList.contains('todo-input')) return;
        focusedNoteId = e.target.dataset.id;
        ensureBar().classList.add('visible');
        setMode('plus');
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

    document.addEventListener('selectionchange', () => {
        if (!bar || !bar.classList.contains('visible') || !isMobileViewport()) return;
        const sel = window.getSelection();
        const hasSelection = !!sel && !sel.isCollapsed && sel.rangeCount > 0;
        // Don't stomp an open color picker back to the plain format row
        if (hasSelection) { if (bar.dataset.mode !== 'color') setMode('format'); }
        // Only demote from format — a collapsed selection must not close an open menu
        else if (bar.dataset.mode === 'format') setMode('plus');
    });

    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', reposition);
        window.visualViewport.addEventListener('scroll', reposition);
    }
}

initMobileNotesBar();
