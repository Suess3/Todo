const THEME_KEY = 'todo-theme';
const REMINDER_KEY = 'todo-reminder';
const URGENCY_KEY = 'todo-urgency-intensity';
const ACCENT_KEY = 'todo-accent-hue';
const BANNER_KEY = 'todo-banner-photo';

export function getUrgencyIntensity() {
    return parseInt(localStorage.getItem(URGENCY_KEY) ?? '50');
}

export function applyAccent() {
    const hue = parseInt(localStorage.getItem(ACCENT_KEY) ?? '217');
    document.documentElement.style.setProperty('--accent', `hsl(${hue}, 80%, 60%)`);
}

export function applyBannerPhoto() {
    const banner = document.getElementById('app-banner');
    if (!banner) return;
    const data = localStorage.getItem(BANNER_KEY);
    if (data) {
        banner.style.backgroundImage = `url(${data})`;
        banner.classList.add('has-banner');
    } else {
        banner.style.backgroundImage = '';
        banner.classList.remove('has-banner');
    }
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

    // Accent color slider
    const accentSlider = document.getElementById('accent-slider');
    accentSlider.value = parseInt(localStorage.getItem(ACCENT_KEY) ?? '217');
    accentSlider.addEventListener('input', () => {
        localStorage.setItem(ACCENT_KEY, accentSlider.value);
        applyAccent();
    });

    // Banner photo
    const chooseBtn = document.getElementById('banner-choose-btn');
    const removeBtn = document.getElementById('banner-remove-btn');
    const fileInput = document.getElementById('banner-file-input');

    chooseBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const scale = Math.min(1, 1200 / img.width);
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                try {
                    localStorage.setItem(BANNER_KEY, canvas.toDataURL('image/jpeg', 0.8));
                    applyBannerPhoto();
                } catch (e) {
                    alert('Image too large to store. Please choose a smaller image.');
                }
            };
            img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
        fileInput.value = '';
    });

    removeBtn.addEventListener('click', () => {
        localStorage.removeItem(BANNER_KEY);
        applyBannerPhoto();
    });
}
