// Time-series line chart with year slider + animated playback.
// Reads from country.history[metric].

import { formatValue } from './format.js';

let chartInstance = null;
let playInterval = null;

function destroy() {
    if (chartInstance) { try { chartInstance.destroy(); } catch {} chartInstance = null; }
    if (playInterval) { clearInterval(playInterval); playInterval = null; }
}

function readVar(name, fallback) {
    if (typeof window === 'undefined') return fallback;
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
}

function metricsWithHistory(countries) {
    const set = new Set();
    for (const c of countries) {
        for (const k of Object.keys(c.history || {})) {
            if ((c.history[k] || []).length > 1) set.add(k);
        }
    }
    return Array.from(set);
}

function topNByLatest(countries, metric, n = 6) {
    return countries
        .filter(c => (c.history?.[metric] || []).length)
        .map(c => {
            const series = c.history[metric];
            return { country: c, latest: series[series.length - 1].value };
        })
        .sort((a, b) => b.latest - a.latest)
        .slice(0, n)
        .map(x => x.country);
}

function yearRange(countries, metric) {
    let lo = Infinity, hi = -Infinity;
    for (const c of countries) {
        for (const p of c.history?.[metric] || []) {
            if (p.year < lo) lo = p.year;
            if (p.year > hi) hi = p.year;
        }
    }
    return [lo, hi];
}

export function renderTimeSeries({ container, countries, metricDefs }) {
    destroy();
    const available = metricsWithHistory(countries);
    if (available.length === 0) {
        container.innerHTML = `<p class="result-text">No time-series data yet. Add a sheet whose name ends in <code>_history</code> to any .xlsx file (see docs/datasets.md).</p>`;
        return;
    }

    container.innerHTML = `
        <div class="ts-controls">
            <label>Metric
                <select id="ts-metric">
                    ${available.map(k => {
                        const def = metricDefs.find(d => d.key === k);
                        return `<option value="${escapeAttr(k)}">${escapeHtml(def?.label || k)}</option>`;
                    }).join('')}
                </select>
            </label>
            <label>Year <span id="ts-year">–</span>
                <input type="range" id="ts-slider" min="0" max="0" value="0" />
            </label>
            <button type="button" id="ts-play">Play</button>
        </div>
        <canvas id="ts-canvas"></canvas>
    `;

    const $metric = container.querySelector('#ts-metric');
    const $slider = container.querySelector('#ts-slider');
    const $year = container.querySelector('#ts-year');
    const $play = container.querySelector('#ts-play');

    function update() {
        const metric = $metric.value;
        const def = metricDefs.find(d => d.key === metric);
        const series = topNByLatest(countries, metric);
        const [lo, hi] = yearRange(series, metric);
        const years = [];
        for (let y = lo; y <= hi; y++) years.push(y);

        $slider.min = 0;
        $slider.max = String(years.length - 1);
        if (Number(slider().value) >= years.length) $slider.value = String(years.length - 1);

        function drawAtYearIndex(idx) {
            const upTo = years[idx];
            $year.textContent = String(upTo);
            const theme = {
                text: readVar('--text', '#202122'),
                muted: readVar('--muted', '#54595d'),
                grid: readVar('--border-soft', '#c8ccd1')
            };
            const palette = ['#2a6fb5', '#b53a2a', '#2aa66f', '#a62a96', '#a6862a', '#2a8aa6', '#6f2aa6', '#a64a2a'];

            if (chartInstance) try { chartInstance.destroy(); } catch {}
            chartInstance = new window.Chart(container.querySelector('#ts-canvas'), {
                type: 'line',
                data: {
                    labels: years.slice(0, idx + 1),
                    datasets: series.map((c, i) => ({
                        label: c.name,
                        data: (c.history[metric] || [])
                            .filter(p => p.year <= upTo)
                            .map(p => ({ x: p.year, y: p.value })),
                        borderColor: palette[i % palette.length],
                        backgroundColor: palette[i % palette.length],
                        tension: 0.2,
                        spanGaps: true
                    }))
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { labels: { color: theme.text } },
                        tooltip: {
                            callbacks: {
                                label: ctx => `${ctx.dataset.label}: ${formatValue(ctx.parsed.y, def)}`
                            }
                        }
                    },
                    scales: {
                        x: {
                            type: 'linear',
                            min: lo,
                            max: hi,
                            title: { display: true, text: 'Year', color: theme.muted },
                            ticks: { color: theme.muted, stepSize: 1 },
                            grid: { color: theme.grid }
                        },
                        y: {
                            type: def?.scale === 'log' ? 'logarithmic' : 'linear',
                            title: { display: true, text: def?.label || metric, color: theme.muted },
                            ticks: { color: theme.muted, callback: v => formatValue(Number(v), def) },
                            grid: { color: theme.grid }
                        }
                    }
                }
            });
        }

        drawAtYearIndex(Number($slider.value));
        $slider.oninput = () => drawAtYearIndex(Number($slider.value));

        $play.onclick = () => {
            if (playInterval) {
                clearInterval(playInterval);
                playInterval = null;
                $play.textContent = 'Play';
                return;
            }
            $play.textContent = 'Pause';
            playInterval = setInterval(() => {
                let v = Number($slider.value) + 1;
                if (v > Number($slider.max)) v = 0;
                $slider.value = String(v);
                drawAtYearIndex(v);
            }, 600);
        };
    }

    function slider() { return container.querySelector('#ts-slider'); }

    $metric.addEventListener('change', update);
    update();
}
function escapeHtml(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }
