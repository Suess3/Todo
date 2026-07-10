import { getLang, setLang, applyTranslations } from './i18n.js';

const THEME_KEY = 'todo-theme';
const URGENCY_KEY = 'todo-urgency-intensity';
const ACCENT_KEY = 'todo-accent-hue';
const BG_BRIGHTNESS_KEY = 'todo-bg-brightness';
const BG_PATTERN_KEY = 'todo-bg-pattern';
const BG_PATTERN_OPACITY_KEY = 'todo-bg-pattern-opacity';
const BANNER_KEY = 'todo-banner-photo';
const BANNER_POS_KEY = 'todo-banner-pos';

export function getUrgencyIntensity() {
    return parseInt(localStorage.getItem(URGENCY_KEY) ?? '50');
}

// These vars must be set on <body>, not <html>: data-theme lives on body and the
// [data-theme="light"] block redefines them there, so an inline style on html would
// be shadowed by body's own declaration (the light-mode "sliders do nothing" bug).
export function applyAccent() {
    const hue = parseInt(localStorage.getItem(ACCENT_KEY) ?? '217');
    document.body.style.setProperty('--accent', `hsl(${hue}, 80%, 60%)`);
}

// Grain is generated noise, not a solid ink color: the dark-mode version shows light
// speckles on the dark bg, so light mode needs a black-speckle version (feColorMatrix
// zeroes RGB, keeps the turbulence alpha) to be visible on white.
const _noiseSvgDark  = `<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/></filter><rect width='200' height='200' filter='url(#n)'/></svg>`;
const _noiseSvgLight = `<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/><feColorMatrix type='matrix' values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0'/></filter><rect width='200' height='200' filter='url(#n)'/></svg>`;
// Pattern ink follows the theme — white lines are invisible on the light theme's
// white background, so light mode draws with black instead
function getPatterns(isLight) {
    const ink = isLight ? '0,0,0' : '255,255,255';
    const noise = isLight ? _noiseSvgLight : _noiseSvgDark;
    return {
        none: null,
        grain: `url("data:image/svg+xml,${encodeURIComponent(noise)}")`,
        dots: `radial-gradient(circle, rgba(${ink},0.7) 1px, transparent 1px)`,
        grid: `linear-gradient(rgba(${ink},0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(${ink},0.5) 1px, transparent 1px)`,
        diagonal: `repeating-linear-gradient(45deg, transparent 0px, transparent 18px, rgba(${ink},0.6) 18px, rgba(${ink},0.6) 19px)`,
        scan: `repeating-linear-gradient(0deg, transparent 0px, transparent 3px, rgba(${ink},0.4) 3px, rgba(${ink},0.4) 4px)`,
    };
}
const PATTERN_SIZES = {
    grain: '200px 200px',
    dots: '20px 20px',
    grid: '24px 24px',
    diagonal: 'auto',
    scan: 'auto',
};

export function applyPattern() {
    const overlay = document.getElementById('bg-pattern-overlay');
    if (!overlay) return;
    const pattern = localStorage.getItem(BG_PATTERN_KEY) || 'none';
    if (pattern === 'none') {
        overlay.style.opacity = '0';
        return;
    }
    const isLight = (localStorage.getItem(THEME_KEY) || 'dark') === 'light';
    // Map 0–100 → 0.01–0.08 — kept deliberately subtle, anything stronger distracts
    const value = parseInt(localStorage.getItem(BG_PATTERN_OPACITY_KEY) ?? '30');
    const opacity = 0.01 + (value / 100) * 0.07;
    overlay.style.backgroundImage = getPatterns(isLight)[pattern];
    overlay.style.backgroundSize = PATTERN_SIZES[pattern] || 'auto';
    overlay.style.opacity = opacity.toFixed(3);
}

export function applyBgBrightness() {
    const theme = localStorage.getItem(THEME_KEY) || 'dark';
    const value = parseInt(localStorage.getItem(BG_BRIGHTNESS_KEY) ?? '0');
    const hex = v => `#${v.toString(16).padStart(2, '0').repeat(3)}`;

    let bg, surface, modal;
    if (theme === 'light') {
        // 0 → #ffffff (255) down to "dirty white" #c8c8c8 (200); inputs track the
        // theme default #f5f5f5 (245) with the same travel. At 0 everything matches
        // the plain light theme exactly (modals are white there, not surface-toned).
        bg = Math.round(255 - (value / 100) * 55);
        surface = Math.round(245 - (value / 100) * 55);
        modal = bg;
    } else {
        // 0 → #121212 (18), 100 → #666666 (102); surfaces #1e1e1e (30) → #666 (102)
        bg = Math.round(18 + (value / 100) * 84);
        surface = Math.round(30 + (value / 100) * 72);
        modal = surface;
    }
    document.body.style.setProperty('--bg', hex(bg));
    document.body.style.setProperty('--input-bg', hex(surface));
    document.body.style.setProperty('--modal-bg', hex(modal));
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
    // The pattern ink is theme-dependent (white on dark, black on light)
    applyPattern();
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

    // Language toggle (checked = DE)
    const langToggle = document.getElementById('lang-toggle');
    langToggle.checked = getLang() === 'de';
    langToggle.addEventListener('change', () => {
        setLang(langToggle.checked ? 'de' : 'en');
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

    // Pattern picker
    const patternOpacityRow = document.getElementById('pattern-opacity-row');
    const patternSlider = document.getElementById('pattern-slider');
    const patternBtns = document.querySelectorAll('.pattern-btn');
    const savedPattern = localStorage.getItem(BG_PATTERN_KEY) || 'none';
    patternSlider.value = parseInt(localStorage.getItem(BG_PATTERN_OPACITY_KEY) ?? '30');
    patternOpacityRow.classList.toggle('hidden', savedPattern === 'none');

    patternBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.pattern === savedPattern);
        btn.addEventListener('click', () => {
            patternBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const pattern = btn.dataset.pattern;
            localStorage.setItem(BG_PATTERN_KEY, pattern);
            patternOpacityRow.classList.toggle('hidden', pattern === 'none');
            applyPattern();
        });
    });

    patternSlider.addEventListener('input', () => {
        localStorage.setItem(BG_PATTERN_OPACITY_KEY, patternSlider.value);
        applyPattern();
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

    applyTranslations();
}
