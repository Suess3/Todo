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

function getHue() {
    return parseInt(localStorage.getItem('todo-accent-hue') ?? '217');
}

function burstAt(cx, cy, count, hue, speedMult = 1) {
    const colors = [
        `hsl(${hue}, 80%, 65%)`,
        `hsl(${hue}, 80%, 65%)`,
        `hsl(${hue}, 55%, 80%)`,
        '#ffffff',
    ];
    for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 / count) * i + (Math.random() - 0.5) * 0.5;
        const speed = (3 + Math.random() * 4.5) * speedMult;
        particles.push({
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

// All today's checkboxes bounce in staggered sequence, then one big burst from the section center
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
    const sectionRect = section?.getBoundingClientRect();
    const cx = sectionRect ? sectionRect.left + sectionRect.width / 2 : window.innerWidth / 2;
    const cy = sectionRect ? sectionRect.top + sectionRect.height / 2 : window.innerHeight / 2;

    setTimeout(() => {
        burstAt(cx, cy, 40, hue, 1.8);
        if (!animating) { animating = true; requestAnimationFrame(tick); }
    }, Math.max(boxes.length * 90 + 150, 300));
}

function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.18;
        p.vx *= 0.96;
        p.vy *= 0.98;
        p.size *= 0.98;
        p.opacity -= p.decay;
        if (p.opacity <= 0.02) { particles.splice(i, 1); continue; }
        ctx.save();
        ctx.globalAlpha = p.opacity;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.1, p.size), 0, Math.PI * 2);
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
