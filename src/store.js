// Shared mutable state for the renderer modules. Importers read the live
// bindings directly; wholesale reassignment has to go through the setters
// (imported bindings are read-only views).

export let todos = [];
export function setTodos(next) { todos = next; }

// Ids with local edits that haven't reached Firestore yet — an incoming
// snapshot must never overwrite these (see scheduleRender's dirty-merge).
export const dirtyIds = new Set();

export let currentPage = 'todo';
export function setCurrentPage(page) { currentPage = page; }

// { id, cursor } — focus a specific input after the next render
export let focusTarget = null;
export function setFocusTarget(target) { focusTarget = target; }

// todo id → nesting depth for the current render pass (Notes indentation),
// filled by flattenForDisplay()
export const flatDepthMap = new Map();

// render.js registers renderApp here; lower modules trigger renders through
// this hook instead of importing render.js, which would be circular.
export let rerender = () => {};
export function setRenderer(fn) { rerender = fn; }

// Ids of rows marked by a cross-row drag (selection.js). Kept here so the
// renderer can re-apply the highlight after every reconcile.
export const selectedIds = new Set();
