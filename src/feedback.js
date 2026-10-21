// User feedback: the save-status pill in the header and toast notifications.

import { t } from './i18n.js';

// Firestore write promises only settle once the server acknowledges them, so
// offline a 'saving' status would hang forever. Offline wins over it instead;
// the queued writes go out (and the promises settle) once the connection is back.
let lastStatus = 'idle';

export function updateSaveStatus(status) {
    lastStatus = status;
    const el = document.getElementById('save-status');
    if (!el) return;
    el.classList.remove('hidden', 'error', 'offline');
    if (!navigator.onLine) {
        el.textContent = t(status === 'idle' ? 'status_offline_idle' : 'status_offline');
        el.classList.add('offline');
    } else if (status === 'saving') {
        el.textContent = t('status_saving');
    } else if (status === 'error') {
        el.textContent = t('status_error');
        el.classList.add('error');
    } else {
        el.classList.add('hidden');
    }
}

window.addEventListener('online', () => updateSaveStatus(lastStatus));
window.addEventListener('offline', () => updateSaveStatus(lastStatus));
document.addEventListener('lang-changed', () => updateSaveStatus(lastStatus));
updateSaveStatus('idle');

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
