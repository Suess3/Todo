import { db, auth } from './firebase.js';
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Mirrors the urgency palette from render.js
const CHART_COLORS = [
    { label: 'Same day', light: '#CCCCCC', dark: '#555555' },
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

async function loadCharts() {
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    document.getElementById('charts-loading').classList.remove('hidden');
    document.getElementById('charts-content').classList.add('hidden');

    try {
        const snapshot = await getDocs(
            query(collection(db, 'users', uid, 'todos'), where('isDone', '==', true))
        );

        const done = [];
        snapshot.forEach(d => done.push(d.data()));

        // Only the main todo page (page field is 'todo' or absent on older entries)
        const todosDone = done.filter(t => (!t.page || t.page === 'todo') && t.completedAt);

        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const weekly  = todosDone.filter(t => t.completedAt >= weekAgo);

        renderPie('week-chart',    weekly,    `This Week (${weekly.length})`);
        renderPie('alltime-chart', todosDone, `All Time (${todosDone.length})`);
    } catch (e) {
        console.error('charts:', e);
    }

    document.getElementById('charts-loading').classList.add('hidden');
    document.getElementById('charts-content').classList.remove('hidden');
}

function groupByMoveCount(todos) {
    const counts = [0, 0, 0, 0, 0, 0]; // buckets: 0,1,2,3,4,5+
    todos.forEach(t => { counts[Math.min(t.moveCount || 0, 5)]++; });
    return counts;
}

function renderPie(canvasId, todos, title) {
    const canvas = document.getElementById(canvasId);
    const isDark  = document.body.getAttribute('data-theme') !== 'light';
    const textColor = isDark ? '#cccccc' : '#333333';

    // Destroy previous chart instance on re-open
    const existing = window.Chart?.getChart(canvas);
    if (existing) existing.destroy();

    const counts = groupByMoveCount(todos);

    // Only include buckets that have at least one todo
    const labels = [], data = [], colors = [];
    CHART_COLORS.forEach((c, i) => {
        if (counts[i] === 0) return;
        labels.push(c.label);
        data.push(counts[i]);
        colors.push(i === 0 ? (isDark ? c.dark : c.light) : c.color);
    });

    if (data.length === 0) {
        // Nothing completed yet — show an empty placeholder slice
        labels.push('No data');
        data.push(1);
        colors.push(isDark ? '#333333' : '#e0e0e0');
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
                            if (ctx.label === 'No data') return ' No completed todos yet';
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
