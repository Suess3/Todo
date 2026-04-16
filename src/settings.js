const THEME_KEY = 'todo-theme';
const REMINDER_KEY = 'todo-reminder';
const URGENCY_KEY = 'todo-urgency-intensity';

export function getUrgencyIntensity() {
    return parseInt(localStorage.getItem(URGENCY_KEY) ?? '50');
}

let reminderTimer = null;

// --- Theme ---

export function applyTheme() {
    const theme = localStorage.getItem(THEME_KEY) || 'dark';
    document.body.setAttribute('data-theme', theme);
}

function setTheme(theme) {
    localStorage.setItem(THEME_KEY, theme);
    document.body.setAttribute('data-theme', theme);
}

// --- Reminder ---

function scheduleReminder(timeStr) {
    if (reminderTimer) clearTimeout(reminderTimer);

    const [hours, minutes] = timeStr.split(':').map(Number);
    const now = new Date();
    const target = new Date();
    target.setHours(hours, minutes, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);

    const delay = target - now;
    reminderTimer = setTimeout(() => {
        new Notification('Todo', { body: 'Time to check off your todos for today!' });
        scheduleReminder(timeStr); // reschedule for tomorrow
    }, delay);
}

export function initReminder() {
    const saved = JSON.parse(localStorage.getItem(REMINDER_KEY) || '{}');
    if (saved.enabled && saved.time) {
        if (Notification.permission === 'granted') {
            scheduleReminder(saved.time);
        }
    }
}

// --- Settings Modal ---

export function initSettings() {
    const btn = document.getElementById('settings-btn');
    const modal = document.getElementById('settings-modal');
    const closeBtn = document.getElementById('settings-close');
    const themeToggle = document.getElementById('theme-toggle');
    const reminderToggle = document.getElementById('reminder-toggle');
    const reminderTimeRow = document.getElementById('reminder-time-row');
    const reminderTimeInput = document.getElementById('reminder-time');

    // Load saved state
    const currentTheme = localStorage.getItem(THEME_KEY) || 'dark';
    themeToggle.checked = currentTheme === 'light';

    const saved = JSON.parse(localStorage.getItem(REMINDER_KEY) || '{}');
    reminderToggle.checked = !!saved.enabled;
    reminderTimeInput.value = saved.time || '22:00';
    reminderTimeRow.classList.toggle('hidden', !saved.enabled);

    // Open / close
    btn.addEventListener('click', () => modal.classList.remove('hidden'));
    closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.add('hidden');
    });

    // Theme toggle
    themeToggle.addEventListener('change', () => {
        setTheme(themeToggle.checked ? 'light' : 'dark');
    });

    // Reminder toggle
    reminderToggle.addEventListener('change', async () => {
        reminderTimeRow.classList.toggle('hidden', !reminderToggle.checked);
        if (reminderToggle.checked) {
            if (Notification.permission !== 'granted') {
                const permission = await Notification.requestPermission();
                if (permission !== 'granted') {
                    reminderToggle.checked = false;
                    reminderTimeRow.classList.add('hidden');
                    return;
                }
            }
            const time = reminderTimeInput.value || '22:00';
            localStorage.setItem(REMINDER_KEY, JSON.stringify({ enabled: true, time }));
            scheduleReminder(time);
        } else {
            localStorage.setItem(REMINDER_KEY, JSON.stringify({ enabled: false }));
            if (reminderTimer) { clearTimeout(reminderTimer); reminderTimer = null; }
        }
    });

    // Time change
    reminderTimeInput.addEventListener('change', () => {
        const time = reminderTimeInput.value;
        localStorage.setItem(REMINDER_KEY, JSON.stringify({ enabled: true, time }));
        scheduleReminder(time);
    });

    // Urgency slider
    const urgencySlider = document.getElementById('urgency-slider');
    urgencySlider.value = getUrgencyIntensity();
    urgencySlider.addEventListener('input', () => {
        localStorage.setItem(URGENCY_KEY, urgencySlider.value);
        document.dispatchEvent(new CustomEvent('urgency-changed'));
    });
}
