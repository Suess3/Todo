// Recurring todos. A rule (users/{uid}/recurrences) says what and how often;
// on its due day the app turns it into an ordinary todo on today, so checking
// off, undo, dragging and the productivity counter all work unchanged.
//
// Only one todo per rule is open at a time: an unfinished one is carried over by
// moveTodos like any other todo, and no new one is added on top of it.
// Instances get a fixed id (rule id + due day), so two devices generating at the
// same moment land on the same document instead of creating a duplicate.

import { db, auth } from './firebase.js';
import {
    collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, getDocs, getDoc,
    query, where, runTransaction, writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getTodayEpoch } from './todoService.js';
import { recurrences, setRecurrences, rerender, todos } from './store.js';
import { t } from './i18n.js';
import { showToast } from './feedback.js';

const MAX_TEXT = 1000;
// A rule that was not opened for a long time still finds its last due day,
// without walking back through years
const LOOKBACK_DAYS = 400;
// Chip order Mon..Sun; values are getUTCDay() numbers
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const rulesRef = uid => collection(db, 'users', uid, 'recurrences');
const todosRef = uid => collection(db, 'users', uid, 'todos');

// --- Schedule ---

const weekdayOf = epoch => new Date(epoch * 86400000).getUTCDay();

export function isDue(rule, day) {
    if (day < rule.startEpochDay) return false;
    if (rule.kind === 'daily') return true;
    if (rule.kind === 'interval') return (day - rule.startEpochDay) % Math.max(1, rule.interval || 1) === 0;
    if (rule.kind === 'weekdays') return (rule.weekdays || []).includes(weekdayOf(day));
    return false;
}

// Most recent due day after the last generation, up to today — null if none
export function latestDueDay(rule, today) {
    const from = Math.max((rule.lastGeneratedDay ?? rule.startEpochDay - 1) + 1, rule.startEpochDay, today - LOOKBACK_DAYS);
    for (let day = today; day >= from; day--) {
        if (isDue(rule, day)) return day;
    }
    return null;
}

export function describeRule(rule) {
    if (rule.kind === 'daily') return t('recur_daily');
    if (rule.kind === 'interval') return t('recur_every_n').replace('{n}', rule.interval);
    const days = WEEKDAY_ORDER.filter(d => (rule.weekdays || []).includes(d));
    if (days.length === 7) return t('recur_daily');
    return days.map(d => t('wd_short_' + d)).join(', ');
}

// Rules due on a future day of the calendar, minus those that already have a
// real todo there (an instance dragged forward)
export function previewRulesFor(day, dayTodos) {
    if (day <= getTodayEpoch()) return [];
    return recurrences.filter(rule => isDue(rule, day) && !dayTodos.some(t => t.recurrenceId === rule.id));
}

// --- Generation ---

let generateInFlight = null;

// Called after moveTodos, so yesterday's open instance is already on today
export function generateRecurring(uid) {
    if (!generateInFlight) generateInFlight = runGenerate(uid).finally(() => { generateInFlight = null; });
    return generateInFlight;
}

function instanceData(rule, dueDay, today) {
    return {
        text: rule.text,
        isDone: false,
        dateEpochDay: today,
        sortOrder: Date.now(),
        // Due on a day the app was not opened: it counts as carried over once
        moveCount: dueDay < today ? 1 : 0,
        page: 'todo',
        parentId: null,
        isToggle: false,
        collapsed: false,
        createdAt: Date.now(),
        recurrenceId: rule.id,
    };
}

async function runGenerate(uid) {
    const today = getTodayEpoch();
    const rulesSnap = await getDocs(rulesRef(uid));
    const candidates = rulesSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(rule => latestDueDay(rule, today) !== null);
    if (candidates.length === 0) return;

    const openSnap = await getDocs(query(todosRef(uid), where('isDone', '==', false)));
    const hasOpen = new Set(openSnap.docs.map(d => d.data().recurrenceId).filter(Boolean));

    // Transactions need the server and retry for seconds before giving up offline
    if (navigator.onLine) {
        try {
            await runTransaction(db, async tx => {
                // Re-read the rules: another device may have generated meanwhile
                const fresh = await Promise.all(candidates.map(rule => tx.get(doc(rulesRef(uid), rule.id))));
                const due = fresh
                    .filter(snap => snap.exists())
                    .map(snap => ({ rule: { id: snap.id, ...snap.data() } }))
                    .map(entry => ({ ...entry, day: latestDueDay(entry.rule, today) }))
                    .filter(entry => entry.day !== null);
                const instances = await Promise.all(due.map(({ rule, day }) => tx.get(doc(todosRef(uid), `${rule.id}_${day}`))));
                due.forEach(({ rule, day }, i) => {
                    tx.update(doc(rulesRef(uid), rule.id), { lastGeneratedDay: today });
                    if (!hasOpen.has(rule.id) && !instances[i].exists()) {
                        tx.set(instances[i].ref, instanceData(rule, day, today));
                    }
                });
            });
            return;
        } catch (e) {
            if (e?.code !== 'unavailable') throw e;
        }
    }

    // Offline: write through the local cache. The fixed instance id still keeps
    // two devices from creating two todos for the same day.
    const batch = writeBatch(db);
    for (const rule of candidates) {
        const day = latestDueDay(rule, today);
        const ref = doc(todosRef(uid), `${rule.id}_${day}`);
        batch.update(doc(rulesRef(uid), rule.id), { lastGeneratedDay: today });
        if (hasOpen.has(rule.id)) continue;
        // Already in the local cache (maybe checked off) — don't reset it
        const cached = await getDoc(ref).catch(() => null);
        if (!cached?.exists()) batch.set(ref, instanceData(rule, day, today));
    }
    await batch.commit();
}

// --- Live rules ---

let unsubscribeRules = null;

export function subscribeRecurrences(uid) {
    stopRecurrences();
    unsubscribeRules = onSnapshot(rulesRef(uid), snapshot => {
        const rules = [];
        snapshot.forEach(d => rules.push({ id: d.id, ...d.data() }));
        rules.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        setRecurrences(rules);
        renderRuleList();
        rerender(todos);
    });
}

export function stopRecurrences() {
    if (unsubscribeRules) { unsubscribeRules(); unsubscribeRules = null; }
    setRecurrences([]);
}

// --- Modal ---

let editingId = null;
let formKind = 'daily';
let formWeekdays = new Set();

function readForm() {
    const text = document.getElementById('recur-text').value.trim().slice(0, MAX_TEXT);
    const interval = Math.min(365, Math.max(2, parseInt(document.getElementById('recur-interval').value) || 2));
    return {
        text,
        kind: formKind,
        interval: formKind === 'interval' ? interval : 1,
        weekdays: formKind === 'weekdays' ? WEEKDAY_ORDER.filter(d => formWeekdays.has(d)) : [],
    };
}

function syncFormControls() {
    document.querySelectorAll('#recur-kind .pattern-btn').forEach(b => b.classList.toggle('active', b.dataset.kind === formKind));
    document.getElementById('recur-interval-row').classList.toggle('hidden', formKind !== 'interval');
    document.getElementById('recur-weekday-row').classList.toggle('hidden', formKind !== 'weekdays');
    document.querySelectorAll('#recur-weekday-row .pattern-btn').forEach(b => b.classList.toggle('active', formWeekdays.has(Number(b.dataset.day))));
    document.getElementById('recur-submit').textContent = t(editingId ? 'recur_save' : 'recur_add');
    document.getElementById('recur-cancel').classList.toggle('hidden', !editingId);
    document.getElementById('recur-text').placeholder = t('recur_placeholder');
    document.querySelectorAll('#recur-list .recur-row').forEach(row => row.classList.toggle('editing', row.dataset.id === editingId));
}

function resetForm() {
    editingId = null;
    formKind = 'daily';
    formWeekdays = new Set();
    document.getElementById('recur-text').value = '';
    document.getElementById('recur-interval').value = 2;
    syncFormControls();
}

function startEditing(rule) {
    editingId = rule.id;
    formKind = rule.kind;
    formWeekdays = new Set(rule.weekdays || []);
    document.getElementById('recur-text').value = rule.text;
    document.getElementById('recur-interval').value = rule.kind === 'interval' ? rule.interval : 2;
    syncFormControls();
    document.getElementById('recur-text').focus();
}

function renderRuleList() {
    const list = document.getElementById('recur-list');
    if (!list) return;
    list.replaceChildren();
    if (recurrences.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'recur-empty';
        empty.textContent = t('recur_empty');
        list.appendChild(empty);
    }
    recurrences.forEach(rule => {
        const row = document.createElement('div');
        row.className = 'recur-row';
        row.dataset.id = rule.id;

        const text = document.createElement('span');
        text.className = 'recur-row-text';
        text.textContent = rule.text;
        const rhythm = document.createElement('span');
        rhythm.className = 'recur-row-rhythm';
        rhythm.textContent = describeRule(rule);

        // Two taps to delete — there is no undo for rules
        const del = document.createElement('button');
        del.className = 'recur-del';
        del.textContent = '✕';
        let armTimer = null;
        del.addEventListener('click', e => {
            e.stopPropagation();
            if (!del.classList.contains('armed')) {
                del.classList.add('armed');
                del.textContent = t('recur_confirm_delete');
                armTimer = setTimeout(() => { del.classList.remove('armed'); del.textContent = '✕'; }, 3000);
                return;
            }
            clearTimeout(armTimer);
            if (editingId === rule.id) resetForm();
            deleteRule(rule.id);
        });

        row.append(text, rhythm, del);
        row.addEventListener('click', () => startEditing(rule));
        list.appendChild(row);
    });
    syncFormControls();
}

async function submitForm() {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const data = readForm();
    if (!data.text) { document.getElementById('recur-text').focus(); return; }
    if (data.kind === 'weekdays' && data.weekdays.length === 0) return;

    const today = getTodayEpoch();
    const editing = editingId && recurrences.find(r => r.id === editingId);
    resetForm();
    try {
        if (editing) {
            const rhythmChanged = editing.kind !== data.kind || editing.interval !== data.interval
                || String(editing.weekdays || []) !== String(data.weekdays);
            // A new rhythm counts from today; "every 2 days" then means today, the day after next, ...
            await updateDoc(doc(rulesRef(uid), editing.id), rhythmChanged ? { ...data, startEpochDay: today } : data);
        } else {
            await addDoc(rulesRef(uid), { ...data, startEpochDay: today, lastGeneratedDay: today - 1, createdAt: Date.now() });
        }
        await generateRecurring(uid);
    } catch (e) {
        showToast(t('err_recur_save'), 'error');
        console.error(e);
    }
}

function deleteRule(id) {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    deleteDoc(doc(rulesRef(uid), id)).catch(e => { showToast(t('err_delete'), 'error'); console.error(e); });
}

let recurInitialized = false;

// Module-level listeners; onSignIn calls this again on every sign-in
export function initRecurrence() {
    if (recurInitialized) return;
    recurInitialized = true;

    const btn = document.getElementById('recur-btn');
    const modal = document.getElementById('recur-modal');
    const close = () => { modal.classList.add('hidden'); resetForm(); };
    btn.addEventListener('click', () => { modal.classList.remove('hidden'); renderRuleList(); });
    document.getElementById('recur-close').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    document.querySelectorAll('#recur-kind .pattern-btn').forEach(b => b.addEventListener('click', () => {
        formKind = b.dataset.kind;
        syncFormControls();
    }));

    const weekdayRow = document.getElementById('recur-weekday-row');
    WEEKDAY_ORDER.forEach(day => {
        const chip = document.createElement('button');
        chip.className = 'pattern-btn';
        chip.dataset.day = day;
        chip.addEventListener('click', () => {
            formWeekdays.has(day) ? formWeekdays.delete(day) : formWeekdays.add(day);
            syncFormControls();
        });
        weekdayRow.appendChild(chip);
    });
    const labelChips = () => weekdayRow.querySelectorAll('.pattern-btn').forEach(c => { c.textContent = t('wd_short_' + c.dataset.day); });
    labelChips();

    document.getElementById('recur-submit').addEventListener('click', submitForm);
    document.getElementById('recur-cancel').addEventListener('click', resetForm);
    document.getElementById('recur-text').addEventListener('keydown', e => { if (e.key === 'Enter') submitForm(); });

    document.addEventListener('lang-changed', () => {
        labelChips();
        btn.title = t('recurring');
        renderRuleList();
    });
    btn.title = t('recurring');
    resetForm();
}
