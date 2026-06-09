// World map (dot choropleth v1).
//
// Contract (v1 and v2 share this):
//   renderMap({
//     container,       // HTMLElement to render into
//     countries,       // Country[]
//     coords,          // { name, x, y }[] from andah-map-coords.js
//     metric,          // metricDef.key string
//     metricDefs,      // MetricDef[]
//     onSelect         // (country) => void
//   })
//
// v1 strategy: draw maps/map.png as the canvas background, then for each
// country with a coord plot a circle filled with color scaled by the metric.
// v2 strategy will replace drawCircle() with drawPolygon() against the same
// canvas. The public contract above will not change.

import { formatValue } from './format.js';

const MAP_IMAGE = 'maps/map.png';
const NATURAL_W = 8966;
const NATURAL_H = 3943;

let cachedImage = null;
function loadMapImage() {
    if (cachedImage) return cachedImage;
    cachedImage = new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = MAP_IMAGE;
    });
    return cachedImage;
}

function metricExtent(countries, metric) {
    let min = Infinity, max = -Infinity;
    for (const c of countries) {
        const v = c.metrics?.[metric];
        if (!Number.isFinite(v) || v <= 0) continue;
        if (v < min) min = v;
        if (v > max) max = v;
    }
    if (!Number.isFinite(min)) return [0, 1];
    return [min, max];
}

function logScale([min, max]) {
    const lmin = Math.log10(Math.max(min, 1));
    const lmax = Math.log10(Math.max(max, 10));
    return v => {
        if (!Number.isFinite(v) || v <= 0) return null;
        return (Math.log10(v) - lmin) / Math.max(lmax - lmin, 1e-9);
    };
}

function linScale([min, max]) {
    return v => {
        if (!Number.isFinite(v)) return null;
        return (v - min) / Math.max(max - min, 1e-9);
    };
}

// Single-hue sequential color ramp (light blue -> deep blue), matches the
// Wikipedia-ish palette. Returns a CSS color for t in [0,1].
function colorRamp(t) {
    if (t == null) return 'rgba(200,200,200,0.35)';
    const clamped = Math.max(0, Math.min(1, t));
    const r = Math.round(220 - 180 * clamped);
    const g = Math.round(232 - 150 * clamped);
    const b = Math.round(244 - 50 * clamped);
    return `rgb(${r},${g},${b})`;
}

export async function renderMap({ container, countries, coords, metric, metricDefs, onSelect }) {
    container.innerHTML = `
        <div class="map-frame">
            <canvas class="map-canvas" id="world-map-canvas"></canvas>
            <div class="map-tooltip" id="map-tooltip" hidden></div>
            <div class="map-legend" id="map-legend"></div>
        </div>
    `;

    const canvas = container.querySelector('#world-map-canvas');
    const tooltip = container.querySelector('#map-tooltip');
    const legend = container.querySelector('#map-legend');
    const ctx = canvas.getContext('2d');

    let img;
    try {
        img = await loadMapImage();
    } catch {
        container.innerHTML = '<p class="result-text">Map image could not be loaded.</p>';
        return;
    }

    const def = (metricDefs || []).find(d => d.key === metric);
    const extent = metricExtent(countries, metric);
    const scaler = (def?.scale === 'log') ? logScale(extent) : linScale(extent);
    const coordByName = new Map(coords.map(c => [c.name, c]));

    function resize() {
        const cssW = container.clientWidth || 800;
        const aspect = NATURAL_H / NATURAL_W;
        const cssH = Math.round(cssW * aspect);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        draw(cssW, cssH);
    }

    const dots = [];

    function draw(cssW, cssH) {
        ctx.clearRect(0, 0, cssW, cssH);
        ctx.drawImage(img, 0, 0, cssW, cssH);

        const scaleX = cssW / NATURAL_W;
        const scaleY = cssH / NATURAL_H;
        const radius = Math.max(4, Math.min(12, cssW / 120));

        dots.length = 0;
        for (const c of countries) {
            const coord = coordByName.get(c.name);
            if (!coord) continue;
            const v = c.metrics?.[metric];
            const t = scaler(v);
            const color = colorRamp(t);
            const x = coord.x * scaleX;
            const y = coord.y * scaleY;
            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.strokeStyle = 'rgba(0,0,0,0.4)';
            ctx.lineWidth = 1;
            ctx.fill();
            ctx.stroke();
            dots.push({ country: c, x, y, r: radius });
        }
    }

    function findDot(px, py) {
        let hit = null;
        let best = Infinity;
        for (const d of dots) {
            const dx = px - d.x;
            const dy = py - d.y;
            const dist2 = dx * dx + dy * dy;
            if (dist2 <= d.r * d.r * 1.6 && dist2 < best) {
                hit = d;
                best = dist2;
            }
        }
        return hit;
    }

    canvas.addEventListener('mousemove', e => {
        const rect = canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const hit = findDot(px, py);
        if (hit) {
            tooltip.hidden = false;
            tooltip.style.left = (px + 10) + 'px';
            tooltip.style.top = (py + 10) + 'px';
            const v = hit.country.metrics?.[metric];
            tooltip.innerHTML = `<strong>${hit.country.name}</strong><br>${escapeHtml(def?.label || metric)}: ${formatValue(v, def)}`;
            canvas.style.cursor = 'pointer';
        } else {
            tooltip.hidden = true;
            canvas.style.cursor = 'default';
        }
    });

    canvas.addEventListener('mouseleave', () => { tooltip.hidden = true; });

    canvas.addEventListener('click', e => {
        const rect = canvas.getBoundingClientRect();
        const hit = findDot(e.clientX - rect.left, e.clientY - rect.top);
        if (hit && onSelect) onSelect(hit.country);
    });

    legend.innerHTML = `
        <span class="map-legend-label">${escapeHtml(def?.label || metric)}</span>
        <span class="map-legend-min">${formatValue(extent[0], def)}</span>
        <span class="map-legend-ramp"></span>
        <span class="map-legend-max">${formatValue(extent[1], def)}</span>
    `;

    resize();
    const ro = new ResizeObserver(() => resize());
    ro.observe(container);
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
