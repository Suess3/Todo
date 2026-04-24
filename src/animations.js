// Shared canvas overlay reused for all particle bursts — never re-created
let canvas, ctx;
let particles = [];
let animating = false;

function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999;';
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    resize();
    window.addEventListener('resize', resize);
}

export function triggerCheckAnimation(checkboxWrapper) {
    // --- Bounce: applied to the inner box so it scales from its own center ---
    const box = checkboxWrapper.querySelector('.checkbox');
    if (box) {
        box.classList.remove('checkbox-bounce');
        void box.offsetWidth; // force reflow so removing+re-adding the class restarts the animation
        box.classList.add('checkbox-bounce');
        box.addEventListener('animationend', () => box.classList.remove('checkbox-bounce'), { once: true });
    }

    // --- Particle burst ---
    ensureCanvas();

    const rect = checkboxWrapper.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    // Match the user's chosen accent hue so particles feel like part of the app
    const hue = parseInt(localStorage.getItem('todo-accent-hue') ?? '217');
    const COLORS = [
        `hsl(${hue}, 80%, 65%)`,  // accent
        `hsl(${hue}, 80%, 65%)`,  // accent (double weight)
        `hsl(${hue}, 55%, 80%)`,  // lighter tint
        '#ffffff',                  // white sparkle
    ];

    const COUNT = 12;
    for (let i = 0; i < COUNT; i++) {
        // Evenly spread angles with a little randomness so the burst isn't robotic
        const angle = (Math.PI * 2 / COUNT) * i + (Math.random() - 0.5) * 0.5;
        const speed = 3 + Math.random() * 4.5;
        particles.push({
            x: cx, y: cy,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed - 1.5, // slight upward bias for a livelier feel
            size: 2.5 + Math.random() * 3,
            opacity: 1,
            decay: 0.022 + Math.random() * 0.008, // slight variation so they don't all vanish together
            color: COLORS[Math.floor(Math.random() * COLORS.length)],
        });
    }

    if (!animating) {
        animating = true;
        requestAnimationFrame(tick);
    }
}

function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];

        p.x  += p.vx;
        p.y  += p.vy;
        p.vy += 0.18;  // gravity
        p.vx *= 0.96;  // air resistance
        p.vy *= 0.98;
        p.size    *= 0.98; // shrink as they travel
        p.opacity -= p.decay;

        if (p.opacity <= 0.02) { particles.splice(i, 1); continue; }

        ctx.save();
        ctx.globalAlpha = p.opacity;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.restore();
    }

    if (particles.length > 0) {
        requestAnimationFrame(tick);
    } else {
        animating = false;
    }
}
