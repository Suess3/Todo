import { db, auth } from './firebase.js';
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Mirrors the urgency palette from render.js; bucket 0 is light green (same day = success)
const BUCKETS = [
    { label: 'Same day', color: '#6ee7a0' },  // light green
    { label: 'Day 2',    color: '#F0DC8A' },
    { label: 'Day 3',    color: '#F0B478' },
    { label: 'Day 4',    color: '#E89028' },
    { label: 'Day 5',    color: '#D44A28' },
    { label: '6+ days',  color: '#C83232' },
];

export function initCharts() {
    const btn   = document.getElementById('charts-btn');
    const modal = document.getElementById('charts-modal');
    const close = document.getElementById('charts-close');

    btn.addEventListener('click', () => {
        modal.classList.remove('hidden');
        loadCharts();
    });
    close.addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
}

// Returns a local YYYY-MM-DD key for a date offset by `offsetDays` from today
function dayKey(offsetDays = 0) {
    const d = new Date();
    d.setDate(d.getDate() - offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function loadCharts() {
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    document.getElementById('charts-loading').classList.remove('hidden');
    document.getElementById('charts-content').classList.add('hidden');

    try {
        const snapshot = await getDocs(collection(db, 'users', uid, 'productivity'));

        // Build a map: { 'YYYY-MM-DD': { '0': n, '1': n, ... } }
        const byDay = {};
        snapshot.forEach(d => { byDay[d.id] = d.data(); });

        const weekKeys = new Set(Array.from({ length: 7 }, (_, i) => dayKey(i)));

        const weekData    = aggregate(byDay, key => weekKeys.has(key));
        const allTimeData = aggregate(byDay, () => true);

        const weekTotal    = weekData.reduce((a, b) => a + b, 0);
        const allTimeTotal = allTimeData.reduce((a, b) => a + b, 0);

        renderPie('week-chart',    weekData,    `This Week (${weekTotal})`);
        renderPie('alltime-chart', allTimeData, `All Time (${allTimeTotal})`);
    } catch (e) {
        console.error('charts:', e);
    }

    document.getElementById('charts-loading').classList.add('hidden');
    document.getElementById('charts-content').classList.remove('hidden');
}

// Sum each bucket across all days matching the filter
function aggregate(byDay, filter) {
    const totals = [0, 0, 0, 0, 0, 0];
    Object.entries(byDay).forEach(([key, day]) => {
        if (!filter(key)) return;
        for (let i = 0; i <= 5; i++) {
            totals[i] += day[String(i)] || 0;
        }
    });
    return totals;
}

function renderPie(canvasId, counts, title) {
    const canvas    = document.getElementById(canvasId);
    const isDark    = document.body.getAttribute('data-theme') !== 'light';
    const textColor = isDark ? '#cccccc' : '#333333';

    // Destroy previous chart instance on re-open
    const existing = window.Chart?.getChart(canvas);
    if (existing) existing.destroy();

    // Only include buckets that have data
    const labels = [], data = [], colors = [];
    BUCKETS.forEach((b, i) => {
        if (counts[i] === 0) return;
        labels.push(b.label);
        data.push(counts[i]);
        colors.push(b.color);
    });

    if (data.length === 0) {
        labels.push('No data yet');
        data.push(1);
        colors.push(isDark ? '#2a2a2a' : '#e0e0e0');
    }

    new window.Chart(canvas, {
        type: 'pie',
        data: {
            labels,
            datasets: [{
                data,
                backgroundColor: colors,
                borderColor: isDark ? '#1e1e1e' : '#ffffff',
                borderWidth: 2,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                title: {
                    display: true,
                    text: title,
                    color: textColor,
                    font: { family: "'IM Fell English', serif", size: 15 },
                    padding: { bottom: 10 },
                },
                legend: {
                    position: 'bottom',
                    labels: {
                        color: textColor,
                        font: { family: "'IM Fell English', serif", size: 13 },
                        padding: 10,
                        usePointStyle: true,
                        pointStyleWidth: 10,
                    },
                },
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            if (ctx.label === 'No data yet') return ' Check off your first todo!';
                            const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                            const pct   = ((ctx.parsed / total) * 100).toFixed(1);
                            return ` ${ctx.parsed} todo${ctx.parsed !== 1 ? 's' : ''} (${pct}%)`;
                        },
                    },
                },
            },
        },
    });
}
