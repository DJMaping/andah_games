// Comparison charts: bar (top-N by metric) + scatter (metric X vs metric Y).
// Uses Chart.js via CDN. Caller injects the `Chart` global.

import { formatValue } from './format.js';

let chartInstance = null;

function destroyChart() {
    if (chartInstance) {
        try { chartInstance.destroy(); } catch {}
        chartInstance = null;
    }
}

function readVar(name, fallback) {
    if (typeof window === 'undefined') return fallback;
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
}

function chartTheme() {
    return {
        text: readVar('--text', '#202122'),
        muted: readVar('--muted', '#54595d'),
        grid: readVar('--border-soft', '#c8ccd1'),
        accent: '#2a6fb5'
    };
}

export function renderChartControls({ container, metricDefs, state, onChange }) {
    const visibleDefs = (metricDefs || []).filter(d => !d.hidden);
    container.innerHTML = `
        <div class="chart-controls">
            <label>Chart
                <select id="chart-type">
                    <option value="bar">Bar (top 20)</option>
                    <option value="scatter">Scatter</option>
                </select>
            </label>
            <label>X / metric
                <select id="chart-x">
                    ${visibleDefs.map(d => `<option value="${escapeAttr(d.key)}">${escapeHtml(d.label || d.key)}</option>`).join('')}
                </select>
            </label>
            <label id="chart-y-wrap" hidden>Y
                <select id="chart-y">
                    ${visibleDefs.map(d => `<option value="${escapeAttr(d.key)}">${escapeHtml(d.label || d.key)}</option>`).join('')}
                </select>
            </label>
        </div>
        <canvas id="chart-canvas"></canvas>
    `;

    const $type = container.querySelector('#chart-type');
    const $x = container.querySelector('#chart-x');
    const $y = container.querySelector('#chart-y');
    const $yWrap = container.querySelector('#chart-y-wrap');

    $type.value = state.type;
    $x.value = state.x;
    $y.value = state.y || (visibleDefs[1]?.key || state.x);
    $yWrap.hidden = state.type !== 'scatter';

    $type.addEventListener('change', () => {
        state.type = $type.value;
        $yWrap.hidden = state.type !== 'scatter';
        onChange();
    });
    $x.addEventListener('change', () => { state.x = $x.value; onChange(); });
    $y.addEventListener('change', () => { state.y = $y.value; onChange(); });
}

export function renderChart({ container, countries, metricDefs, state, onSelect }) {
    destroyChart();
    const canvas = container.querySelector('#chart-canvas');
    if (!canvas || typeof window === 'undefined' || !window.Chart) return;

    const theme = chartTheme();
    const xDef = metricDefs.find(d => d.key === state.x);
    const yDef = metricDefs.find(d => d.key === state.y);

    if (state.type === 'bar') {
        const ranked = countries
            .filter(c => Number.isFinite(c.metrics?.[state.x]))
            .sort((a, b) => b.metrics[state.x] - a.metrics[state.x])
            .slice(0, 20);

        chartInstance = new window.Chart(canvas, {
            type: 'bar',
            data: {
                labels: ranked.map(c => c.name),
                datasets: [{
                    label: xDef?.label || state.x,
                    data: ranked.map(c => c.metrics[state.x]),
                    backgroundColor: theme.accent,
                    borderColor: theme.accent
                }]
            },
            options: chartOptions(theme, xDef, null, ranked, onSelect)
        });
    } else {
        const points = countries
            .filter(c => Number.isFinite(c.metrics?.[state.x]) && Number.isFinite(c.metrics?.[state.y]))
            .map(c => ({ x: c.metrics[state.x], y: c.metrics[state.y], country: c }));

        chartInstance = new window.Chart(canvas, {
            type: 'scatter',
            data: {
                datasets: [{
                    label: `${xDef?.label || state.x} vs ${yDef?.label || state.y}`,
                    data: points,
                    backgroundColor: theme.accent,
                    borderColor: theme.accent,
                    pointRadius: 4,
                    pointHoverRadius: 6
                }]
            },
            options: chartOptions(theme, xDef, yDef, points.map(p => p.country), onSelect, true)
        });
    }
}

function chartOptions(theme, xDef, yDef, refList, onSelect, scatter = false) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { labels: { color: theme.text } },
            tooltip: {
                callbacks: {
                    label: ctx => {
                        if (scatter) {
                            const p = ctx.raw;
                            return `${p.country.name}: ${formatValue(p.x, xDef)}, ${formatValue(p.y, yDef)}`;
                        }
                        return `${ctx.label}: ${formatValue(ctx.parsed.y ?? ctx.parsed.x, xDef)}`;
                    }
                }
            }
        },
        scales: {
            x: {
                type: scatter ? (xDef?.scale === 'log' ? 'logarithmic' : 'linear') : 'category',
                title: { display: !!xDef, text: xDef?.label || '', color: theme.muted },
                ticks: { color: theme.muted, callback: v => formatValue(Number(v), xDef) },
                grid: { color: theme.grid }
            },
            y: {
                type: yDef?.scale === 'log' ? 'logarithmic' : 'linear',
                title: { display: !!yDef, text: yDef?.label || '', color: theme.muted },
                ticks: { color: theme.muted, callback: v => formatValue(Number(v), yDef || xDef) },
                grid: { color: theme.grid }
            }
        },
        onClick: (_, els) => {
            if (!onSelect || !els.length) return;
            const idx = els[0].index;
            const country = refList[idx];
            if (country) onSelect(country);
        }
    };
}

function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
}
