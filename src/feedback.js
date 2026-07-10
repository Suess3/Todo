// User feedback: the save-status pill in the header and toast notifications.

export function updateSaveStatus(status) {
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
