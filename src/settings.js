const THEME_KEY = 'todo-theme';
const URGENCY_KEY = 'todo-urgency-intensity';
const ACCENT_KEY = 'todo-accent-hue';
const BG_BRIGHTNESS_KEY = 'todo-bg-brightness';
const BANNER_KEY = 'todo-banner-photo';
const BADGE_KEY = 'todo-badge-enabled';

const BANNER_POS_KEY = 'todo-banner-pos';

export function isBadgeEnabled() {
    return localStorage.getItem(BADGE_KEY) === 'true';
}

export function getUrgencyIntensity() {
    return parseInt(localStorage.getItem(URGENCY_KEY) ?? '50');
}

export function applyAccent() {
    const hue = parseInt(localStorage.getItem(ACCENT_KEY) ?? '217');
    document.documentElement.style.setProperty('--accent', `hsl(${hue}, 80%, 60%)`);
}

export function applyBgBrightness() {
    const theme = localStorage.getItem(THEME_KEY) || 'dark';
    if (theme === 'light') {
        document.documentElement.style.removeProperty('--bg');
        document.documentElement.style.removeProperty('--input-bg');
        document.documentElement.style.removeProperty('--modal-bg');
        return;
    }
    const value = parseInt(localStorage.getItem(BG_BRIGHTNESS_KEY) ?? '0');
    // 0 → #121212 (18), 100 → #666666 (102)
    const bg = Math.round(18 + (value / 100) * 84);
    const surface = Math.round(30 + (value / 100) * 72); // #1e1e1e (30) → #666 (102)
    const hex = v => v.toString(16).padStart(2, '0');
    const bgHex = `#${hex(bg)}${hex(bg)}${hex(bg)}`;
    const surfaceHex = `#${hex(surface)}${hex(surface)}${hex(surface)}`;
    document.documentElement.style.setProperty('--bg', bgHex);
    document.documentElement.style.setProperty('--input-bg', surfaceHex);
    document.documentElement.style.setProperty('--modal-bg', surfaceHex);
}

function getBannerPos() {
    try { return JSON.parse(localStorage.getItem(BANNER_POS_KEY)) || { x: 50, y: 50 }; }
    catch { return { x: 50, y: 50 }; }
}

export function applyBannerPhoto() {
    const banner = document.getElementById('app-banner');
    if (!banner) return;
    const data = localStorage.getItem(BANNER_KEY);
    if (data) {
        const pos = getBannerPos();
        banner.style.backgroundImage = `url(${data})`;
        banner.style.backgroundPosition = `${pos.x}% ${pos.y}%`;
        banner.classList.add('has-banner');
    } else {
        banner.style.backgroundImage = '';
        banner.style.backgroundPosition = '';
        banner.classList.remove('has-banner');
    }
}

export function initBannerDrag() {
    const banner = document.getElementById('app-banner');
    if (!banner) return;

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let pos = getBannerPos();

    const getClient = e => e.touches ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
                                      : { x: e.clientX, y: e.clientY };

    const onStart = e => {
        if (!banner.classList.contains('has-banner')) return;
        dragging = true;
        const c = getClient(e);
        lastX = c.x;
        lastY = c.y;
        pos = getBannerPos();
    };

    const onMove = e => {
        if (!dragging) return;
        e.preventDefault();
        const c = getClient(e);
        const dx = c.x - lastX;
        const dy = c.y - lastY;
        lastX = c.x;
        lastY = c.y;
        pos.x = Math.max(0, Math.min(100, pos.x - dx * 0.15));
        pos.y = Math.max(0, Math.min(100, pos.y - dy * 0.3));
        banner.style.backgroundPosition = `${pos.x}% ${pos.y}%`;
    };

    const onEnd = () => {
        if (!dragging) return;
        dragging = false;
        localStorage.setItem(BANNER_POS_KEY, JSON.stringify(pos));
    };

    banner.addEventListener('mousedown', onStart);
    banner.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchend', onEnd);
}

// --- Theme ---

export function applyTheme() {
    const theme = localStorage.getItem(THEME_KEY) || 'dark';
    document.body.setAttribute('data-theme', theme);
}

function setTheme(theme) {
    localStorage.setItem(THEME_KEY, theme);
    document.body.setAttribute('data-theme', theme);
    applyBgBrightness();
}

// --- Settings Modal ---

export function initSettings() {
    const btn = document.getElementById('settings-btn');
    const modal = document.getElementById('settings-modal');
    const closeBtn = document.getElementById('settings-close');
    const themeToggle = document.getElementById('theme-toggle');

    // Load saved state
    const currentTheme = localStorage.getItem(THEME_KEY) || 'dark';
    themeToggle.checked = currentTheme === 'light';

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

    // Badge toggle
    const badgeToggle = document.getElementById('badge-toggle');
    badgeToggle.checked = isBadgeEnabled();
    badgeToggle.addEventListener('change', async () => {
        if (badgeToggle.checked) {
            if (Notification.permission !== 'granted') {
                const permission = await Notification.requestPermission();
                if (permission !== 'granted') {
                    badgeToggle.checked = false;
                    return;
                }
            }
            localStorage.setItem(BADGE_KEY, 'true');
        } else {
            localStorage.setItem(BADGE_KEY, 'false');
            if ('clearAppBadge' in navigator) navigator.clearAppBadge();
        }
        document.dispatchEvent(new CustomEvent('badge-changed'));
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

    // Background brightness slider
    const bgSlider = document.getElementById('bg-slider');
    bgSlider.value = parseInt(localStorage.getItem(BG_BRIGHTNESS_KEY) ?? '0');
    bgSlider.addEventListener('input', () => {
        localStorage.setItem(BG_BRIGHTNESS_KEY, bgSlider.value);
        applyBgBrightness();
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
