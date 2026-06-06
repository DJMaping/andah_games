// Flight Network — 2D map view.
//
// Clones the canvas approach of views/world-map.js: draw maps/map.png, then plot
// airports (dots sized by population) and routes (quadratic-bézier arcs in pixel
// space, colour by haul, width ∝ demand). Selecting a city dims the rest.
//
// Same instance API as views/flight-globe.js so the page can treat them alike:
//   createMap(container, opts) -> { setData, update, focus, resize, destroy }

// Cache loaded backdrop images by src (the legacy map and the tagged-city map).
const imageCache = new Map();
function loadMapImage(src) {
    if (imageCache.has(src)) return imageCache.get(src);
    const p = new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
    imageCache.set(src, p);
    return p;
}

export function createMap(container, { config, onSelect } = {}) {
    container.innerHTML = `
        <div class="flight-map-frame">
            <canvas class="flight-map-canvas"></canvas>
            <div class="flight-map-tooltip" hidden></div>
        </div>`;
    const canvas = container.querySelector('.flight-map-canvas');
    const tooltip = container.querySelector('.flight-map-tooltip');
    const ctx = canvas.getContext('2d');

    let img = null;
    let MAP_W = 8966, MAP_H = 3943;   // backdrop native size; overridden by setData
    let airports = [];
    let routes = [];
    let selectedId = null;
    let popDomain = [1, 1];
    let dots = [];           // { a, x, y, r } in unscaled CSS px for hit-testing
    let cssW = 0, cssH = 0;

    // Pan/zoom: screen = base * scale + (tx, ty). scale 1 = fit-to-width.
    let scale = 1, tx = 0, ty = 0;
    const MAX_SCALE = 10;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    function clampPan() {
        const w = cssW * scale, h = cssH * scale;
        tx = clamp(tx, Math.min(0, cssW - w), 0);
        ty = clamp(ty, Math.min(0, cssH - h), 0);
    }

    function setBackdrop(map) {
        if (!map) return;
        MAP_W = map.width || MAP_W;
        MAP_H = map.height || MAP_H;
        loadMapImage(map.image || 'maps/map.png')
            .then(i => { img = i; draw(); })
            .catch(() => { /* keep prior backdrop / blank */ });
    }

    function popRadius(a) {
        const [lo, hi] = popDomain;
        const v = (a.metrics && a.metrics.population) || 0;
        const t = hi > lo ? (Math.sqrt(Math.max(v, 1)) - Math.sqrt(lo)) / (Math.sqrt(hi) - Math.sqrt(lo)) : 0.5;
        const base = Math.max(2.5, Math.min(10, cssW / 150));
        return base * (0.6 + 0.9 * Math.max(0, Math.min(1, t)));
    }

    function isIncident(r) { return r.from === selectedId || r.to === selectedId; }

    function draw() {
        if (!img) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        cssW = container.clientWidth || 800;
        cssH = Math.round(cssW * (MAP_H / MAP_W));
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';
        clampPan();
        // Device-pixel-ratio transform, then the pan/zoom viewport transform.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        ctx.translate(tx, ty);
        ctx.scale(scale, scale);

        ctx.drawImage(img, 0, 0, cssW, cssH);

        const sx = cssW / MAP_W;
        const sy = cssH / MAP_H;

        // Routes (under the dots).
        for (const r of routes) {
            const dim = selectedId && !isIncident(r);
            const x0 = r.fromX * sx, y0 = r.fromY * sy;
            const x1 = r.toX * sx, y1 = r.toY * sy;
            const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
            const dx = x1 - x0, dy = y1 - y0;
            const len = Math.hypot(dx, dy) || 1;
            const bow = Math.min(len * 0.18, 60);
            const cx = mx - (dy / len) * bow;   // perpendicular, consistent side
            const cy = my + (dx / len) * bow;

            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.quadraticCurveTo(cx, cy, x1, y1);
            ctx.strokeStyle = dim
                ? `rgba(150,160,170,${config.dimOpacity})`
                : hexToRgba(config.haulColors[r.haul] || config.haulColors.long, selectedId ? 0.95 : 0.55);
            const w = config.arcStrokeMin + (config.arcStrokeMax - config.arcStrokeMin) * (r.demand || 0);
            ctx.lineWidth = (selectedId && isIncident(r)) ? w * 1.6 + 0.6 : w + 0.4;
            ctx.stroke();
        }

        // Dots.
        dots = [];
        for (const a of airports) {
            const x = a.x * sx, y = a.y * sy, r = popRadius(a);
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fillStyle = a.id === selectedId ? config.selectedColor : (a.isHub ? config.hubColor : config.pointColor);
            ctx.strokeStyle = 'rgba(0,0,0,0.45)';
            ctx.lineWidth = a.id === selectedId ? 2 : 1;
            ctx.fill();
            ctx.stroke();
            dots.push({ a, x, y, r });
        }
    }

    // Screen px -> hit dot (dots are stored in unscaled base coords).
    function findDot(px, py) {
        const bx = (px - tx) / scale, by = (py - ty) / scale;
        let hit = null, best = Infinity;
        for (const d of dots) {
            const dx = bx - d.x, dy = by - d.y;
            const dist2 = dx * dx + dy * dy;
            const rr = (d.r + 3) * (d.r + 3);
            if (dist2 <= rr && dist2 < best) { hit = d; best = dist2; }
        }
        return hit;
    }

    let dragging = false, moved = false, lastX = 0, lastY = 0;

    canvas.addEventListener('mousemove', e => {
        const rect = canvas.getBoundingClientRect();
        const px = e.clientX - rect.left, py = e.clientY - rect.top;
        if (dragging) { tooltip.hidden = true; return; }
        const hit = findDot(px, py);
        if (hit) {
            tooltip.hidden = false;
            tooltip.style.left = (px + 12) + 'px';
            tooltip.style.top = (py + 12) + 'px';
            tooltip.innerHTML = `<strong>${esc(hit.a.city)}</strong><br>${esc(hit.a.country)} · ${hit.a.degree || 0} routes`;
            canvas.style.cursor = 'pointer';
        } else {
            tooltip.hidden = true;
            canvas.style.cursor = scale > 1 ? 'grab' : 'default';
        }
    });
    canvas.addEventListener('mouseleave', () => { tooltip.hidden = true; });

    // Wheel to zoom toward the cursor.
    canvas.addEventListener('wheel', e => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const px = e.clientX - rect.left, py = e.clientY - rect.top;
        const bx = (px - tx) / scale, by = (py - ty) / scale;
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        scale = clamp(scale * factor, 1, MAX_SCALE);
        tx = px - bx * scale;
        ty = py - by * scale;
        draw();
    }, { passive: false });

    // Drag to pan.
    canvas.addEventListener('pointerdown', e => {
        dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY;
        canvas.setPointerCapture(e.pointerId);
        canvas.style.cursor = 'grabbing';
    });
    canvas.addEventListener('pointermove', e => {
        if (!dragging) return;
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        tx += dx; ty += dy;
        lastX = e.clientX; lastY = e.clientY;
        draw();
    });
    const endDrag = e => {
        if (!dragging) return;
        dragging = false;
        try { canvas.releasePointerCapture(e.pointerId); } catch {}
        canvas.style.cursor = scale > 1 ? 'grab' : 'default';
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    // Click selects a dot — unless the pointer was dragged (a pan).
    canvas.addEventListener('click', e => {
        if (moved) { moved = false; return; }
        const rect = canvas.getBoundingClientRect();
        const hit = findDot(e.clientX - rect.left, e.clientY - rect.top);
        if (hit && onSelect) onSelect(hit.a.id);
    });

    const ro = new ResizeObserver(() => draw());
    ro.observe(container);

    return {
        setData(net) {
            airports = net.airports || [];
            const pops = airports.map(a => (a.metrics && a.metrics.population) || 0).filter(v => v > 0);
            popDomain = pops.length ? [Math.min(...pops), Math.max(...pops)] : [1, 1];
            setBackdrop(net.map);
            draw();
        },
        update({ visibleRoutes, selectedId: sel }) {
            routes = visibleRoutes || [];
            selectedId = sel || null;
            draw();
        },
        focus() { /* 2D map shows the whole world; nothing to pan. */ },
        resize() { draw(); },
        destroy() { ro.disconnect(); container.innerHTML = ''; }
    };
}

function hexToRgba(hex, alpha) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return `rgba(120,120,120,${alpha})`;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}

function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
