let canvas, ctx;
let particles = [];
let rings = [];
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

function getHue() {
    return parseInt(localStorage.getItem('todo-accent-hue') ?? '217');
}

function accentColors(hue) {
    return [
        `hsl(${hue}, 80%, 65%)`,
        `hsl(${hue}, 80%, 65%)`,
        `hsl(${hue}, 55%, 80%)`,
        '#ffffff',
    ];
}

function burstAt(cx, cy, count, hue, speedMult = 1) {
    const colors = accentColors(hue);
    for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 / count) * i + (Math.random() - 0.5) * 0.5;
        const speed = (3 + Math.random() * 4.5) * speedMult;
        particles.push({
            type: 'circle',
            x: cx, y: cy,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed - 1.5 * speedMult,
            size: 2.5 + Math.random() * 3,
            opacity: 1,
            decay: 0.022 + Math.random() * 0.008,
            color: colors[Math.floor(Math.random() * colors.length)],
        });
    }
}

export function triggerCheckAnimation(checkboxWrapper) {
    const box = checkboxWrapper.querySelector('.checkbox');
    if (box) {
        box.classList.remove('checkbox-bounce');
        void box.offsetWidth;
        box.classList.add('checkbox-bounce');
        box.addEventListener('animationend', () => box.classList.remove('checkbox-bounce'), { once: true });
    }
    ensureCanvas();
    const rect = checkboxWrapper.getBoundingClientRect();
    burstAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 12, getHue());
    if (!animating) { animating = true; requestAnimationFrame(tick); }
}

// --- Fireworks: 4 staggered bursts at different screen positions ---
export function triggerFireworks() {
    ensureCanvas();
    const hue = getHue();
    const W = canvas.width, H = canvas.height;
    [
        { x: W * 0.25, y: H * 0.22, delay: 0 },
        { x: W * 0.72, y: H * 0.30, delay: 380 },
        { x: W * 0.45, y: H * 0.15, delay: 720 },
        { x: W * 0.62, y: H * 0.26, delay: 1060 },
    ].forEach(({ x, y, delay }) => {
        setTimeout(() => {
            burstAt(x, y, 30, hue, 1.6);
            if (!animating) { animating = true; requestAnimationFrame(tick); }
        }, delay);
    });
}

// --- Cascade: stagger-bounce all today's checkboxes, then one big burst ---
export function triggerCascade() {
    const today = Math.floor(Date.now() / 86400000);
    const section = document.querySelector(`.day-section[data-epoch="${today}"]`);
    const boxes = section ? [...section.querySelectorAll('.checkbox')] : [];

    boxes.forEach((box, i) => {
        setTimeout(() => {
            box.classList.remove('checkbox-bounce');
            void box.offsetWidth;
            box.classList.add('checkbox-bounce');
            box.addEventListener('animationend', () => box.classList.remove('checkbox-bounce'), { once: true });
        }, i * 90);
    });

    ensureCanvas();
    const hue = getHue();
    const cx = section ? section.getBoundingClientRect().left + section.getBoundingClientRect().width / 2 : window.innerWidth / 2;
    const cy = section ? section.getBoundingClientRect().top + section.getBoundingClientRect().height / 2 : window.innerHeight / 2;

    setTimeout(() => {
        burstAt(cx, cy, 40, hue, 1.8);
        if (!animating) { animating = true; requestAnimationFrame(tick); }
    }, Math.max(boxes.length * 90 + 150, 300));
}

// --- Confetti: circles + rectangles falling from the top ---
export function triggerConfetti() {
    ensureCanvas();
    const hue = getHue();
    const colors = [
        `hsl(${hue}, 80%, 65%)`,
        `hsl(${hue}, 55%, 80%)`,
        `hsl(${(hue + 120) % 360}, 70%, 70%)`,
        `hsl(${(hue + 240) % 360}, 70%, 70%)`,
        '#ffffff',
    ];
    for (let i = 0; i < 90; i++) {
        const isRect = Math.random() > 0.45;
        particles.push({
            type: isRect ? 'rect' : 'circle',
            x: Math.random() * canvas.width,
            y: -10 - Math.random() * 80,
            vx: (Math.random() - 0.5) * 2,
            vy: 2 + Math.random() * 3,
            size: 4 + Math.random() * 3,
            width: 7 + Math.random() * 5,
            height: 4 + Math.random() * 3,
            rotation: Math.random() * Math.PI * 2,
            rotationSpeed: (Math.random() - 0.5) * 0.15,
            opacity: 1,
            decay: 0.008 + Math.random() * 0.006,
            color: colors[Math.floor(Math.random() * colors.length)],
        });
    }
    if (!animating) { animating = true; requestAnimationFrame(tick); }
}

// --- Ripple + burst: expanding ring then particle burst from center ---
export function triggerRippleBurst(cx, cy) {
    ensureCanvas();
    const hue = getHue();
    rings.push({
        x: cx, y: cy,
        radius: 10,
        speed: 14,
        opacity: 0.8,
        decay: 0.011,
        color: `hsl(${hue}, 80%, 65%)`,
        lineWidth: 3,
    });
    setTimeout(() => {
        burstAt(cx, cy, 28, hue, 1.4);
        if (!animating) { animating = true; requestAnimationFrame(tick); }
    }, 300);
    if (!animating) { animating = true; requestAnimationFrame(tick); }
}

// --- Demo: play all four in sequence ---
export function playDemoSequence() {
    triggerFireworks();
    setTimeout(triggerCascade, 2800);
    setTimeout(triggerConfetti, 5600);
    setTimeout(() => triggerRippleBurst(window.innerWidth / 2, window.innerHeight / 2), 9500);
}

function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let i = rings.length - 1; i >= 0; i--) {
        const r = rings[i];
        r.radius += r.speed;
        r.opacity -= r.decay;
        if (r.opacity <= 0.01) { rings.splice(i, 1); continue; }
        ctx.save();
        ctx.globalAlpha = r.opacity;
        ctx.beginPath();
        ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
        ctx.strokeStyle = r.color;
        ctx.lineWidth = r.lineWidth;
        ctx.stroke();
        ctx.restore();
    }

    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.18;
        p.vx *= 0.96;
        p.vy *= 0.98;
        p.opacity -= p.decay;
        if (p.opacity <= 0.02) { particles.splice(i, 1); continue; }

        ctx.save();
        ctx.globalAlpha = p.opacity;
        ctx.fillStyle = p.color;

        if (p.type === 'rect') {
            p.rotation += p.rotationSpeed;
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rotation);
            ctx.fillRect(-p.width / 2, -p.height / 2, p.width, p.height);
        } else {
            p.size *= 0.98;
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(0.1, p.size), 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    if (particles.length > 0 || rings.length > 0) {
        requestAnimationFrame(tick);
    } else {
        animating = false;
    }
}
