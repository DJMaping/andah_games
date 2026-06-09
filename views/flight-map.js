// Flight Network — 2D map view.
//
// Clones the canvas approach of views/world-map.js: draw maps/map.png, then plot
// airports (dots sized by population) and routes (quadratic-bézier arcs in pixel
// space, colour by haul, width ∝ demand). Selecting a city dims the rest.
//
// Same instance API as views/flight-globe.js so the page can treat them alike:
//   createMap(container, opts) -> { setData, update, focus, resize, destroy }

import { degreeColor } from './flight-config.js';

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
    let cssW = 0, cssH = 0, dpr = 0;

    // The scene (backdrop + arcs + dots) is rendered in base coordinates and
    // cached on an offscreen canvas. Pan/zoom is then a single blit of that
    // cache through the viewport transform — no re-tessellating 7,000 arcs per
    // frame. The cache is rebuilt only when the scene actually changes (data,
    // selection, size, or the zoomed-out thinning state).
    const offscreen = document.createElement('canvas');
    const octx = offscreen.getContext('2d');
    let cacheValid = false;
    let cacheThin = false;
    // Memoise the degree->dot-colour lookup (degreeColor walks the bands array).
    const degColorCache = new Map();
    function dotColor(degree) {
        let c = degColorCache.get(degree);
        if (c === undefined) { c = degreeColor(degree, config); degColorCache.set(degree, c); }
        return c;
    }

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
            .then(i => { img = i; invalidate(); })
            .catch(() => { /* keep prior backdrop / blank */ });
    }

    function popRadius(a) {
        const [lo, hi] = popDomain;
        const v = (a.metrics && a.metrics.population) || 0;
        const t = hi > lo ? (Math.sqrt(Math.max(v, 1)) - Math.sqrt(lo)) / (Math.sqrt(hi) - Math.sqrt(lo)) : 0.5;
        const base = Math.max(1, Math.min(3.5, cssW / 400));
        return base * (0.6 + 0.9 * Math.max(0, Math.min(1, t)));
    }

    function isIncident(r) { return r.from === selectedId || r.to === selectedId; }

    // Faint routes are dropped only when nothing is selected and we're zoomed
    // out — they read as invisible hairlines there. Selecting a city or zooming
    // in draws the full set. (Cutoff of 0 in config = always draw everything.)
    function wantThin() {
        const cutoff = config.mapMinDemandZoomedOut || 0;
        return !selectedId && cutoff > 0 && scale <= 1.01;
    }

    // Recompute cssW/cssH/dpr from the container; resize the visible canvas only
    // when those actually change (reallocating the backing store every frame is
    // what made dragging stutter). Returns nothing; sets cacheValid=false on resize.
    function measure() {
        const ndpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = container.clientWidth || 800;
        const h = Math.round(w * (MAP_H / MAP_W));
        if (w !== cssW || h !== cssH || ndpr !== dpr) {
            cssW = w; cssH = h; dpr = ndpr;
            canvas.width = Math.round(cssW * dpr);
            canvas.height = Math.round(cssH * dpr);
            canvas.style.width = cssW + 'px';
            canvas.style.height = cssH + 'px';
            cacheValid = false;
        }
    }

    // Paint the vector scene (arcs then dots) into context `g`, in base coords.
    // Used both for the offscreen cache and for a crisp direct redraw at rest.
    function paintVectors(g, thin) {
        const sx = cssW / MAP_W;
        const sy = cssH / MAP_H;
        const cutoff = config.mapMinDemandZoomedOut || 0;

        // Accumulate arcs into one Path2D per (colour, quantised width) instead
        // of stroking each of ~7,000 individually. Width is bucketed to 0.05px
        // (imperceptible) so the whole route layer strokes in ~a dozen calls.
        const batches = new Map();
        function arc(x0, y0, x1, y1, stroke, width) {
            const wq = Math.round(width * 20) / 20;
            const k = stroke + '@' + wq;
            let b = batches.get(k);
            if (!b) { b = { stroke, width: wq, path: new Path2D() }; batches.set(k, b); }
            const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
            const dx = x1 - x0, dy = y1 - y0;
            const len = Math.hypot(dx, dy) || 1;
            const bow = Math.min(len * 0.18, 60);
            const cx = mx - (dy / len) * bow;   // perpendicular, consistent side
            const cy = my + (dx / len) * bow;
            b.path.moveTo(x0, y0);
            b.path.quadraticCurveTo(cx, cy, x1, y1);
        }
        function flushArcs() {
            for (const b of batches.values()) {
                g.strokeStyle = b.stroke;
                g.lineWidth = b.width;
                g.stroke(b.path);
            }
        }

        // Pre-resolve the handful of stroke colours once, instead of parsing a
        // hex string per route (×7,000) inside the loop.
        const alpha = selectedId ? 0.95 : 0.55;
        const dimStroke = `rgba(150,160,170,${config.dimOpacity})`;
        const haulStroke = {};
        for (const k in config.haulColors) haulStroke[k] = hexToRgba(config.haulColors[k], alpha);
        const fallbackStroke = haulStroke.long || hexToRgba(config.haulColors.long, alpha);

        // Routes (under the dots).
        const wrapW = cssW;   // map spans 0..cssW on screen; wrapping width is the full map
        for (const r of routes) {
            const inc = isIncident(r);
            if (thin && !inc && (r.demand || 0) < cutoff) continue;
            const dim = selectedId && !inc;
            const x0 = r.fromX * sx, y0 = r.fromY * sy;
            const x1 = r.toX * sx, y1 = r.toY * sy;
            const stroke = dim ? dimStroke : (haulStroke[r.haul] || fallbackStroke);
            const w = config.arcStrokeMin + (config.arcStrokeMax - config.arcStrokeMin) * (r.demand || 0);
            const width = (selectedId && inc) ? w * 1.6 + 0.4 : w + 0.18;

            // If the cities sit more than half the map apart horizontally, it's
            // shorter to cross the edge than the middle — draw two arcs that run
            // off opposite sides instead of one that cuts straight across.
            if (Math.abs(x1 - x0) > wrapW / 2) {
                const dir = x1 > x0 ? 1 : -1;   // shift the nearer point past the far edge
                arc(x0, y0, x1 - dir * wrapW, y1, stroke, width);
                arc(x0 + dir * wrapW, y0, x1, y1, stroke, width);
            } else {
                arc(x0, y0, x1, y1, stroke, width);
            }
        }
        flushArcs();   // stroke all batched routes (~a dozen calls, not ~7,000)

        // Dots (always all airports; cached in base coords for hit-testing).
        dots = [];
        for (const a of airports) {
            const x = a.x * sx, y = a.y * sy, r = popRadius(a);
            g.beginPath();
            g.arc(x, y, r, 0, Math.PI * 2);
            g.fillStyle = a.id === selectedId ? config.selectedColor : dotColor(a.degree);
            g.strokeStyle = 'rgba(0,0,0,0.45)';
            g.lineWidth = a.id === selectedId ? 2 : 1;
            g.fill();
            g.stroke();
            dots.push({ a, x, y, r });
        }
    }

    // Rebuild the offscreen scene cache at base resolution (no pan/zoom).
    function buildScene(thin) {
        offscreen.width = Math.round(cssW * dpr);
        offscreen.height = Math.round(cssH * dpr);
        octx.setTransform(dpr, 0, 0, dpr, 0, 0);
        octx.clearRect(0, 0, cssW, cssH);
        octx.drawImage(img, 0, 0, cssW, cssH);
        paintVectors(octx, thin);
        cacheThin = thin;
        cacheValid = true;
    }

    // Fast per-frame path: blit the cached scene through the viewport transform.
    function composite() {
        if (!img) return;
        const thin = wantThin();
        if (cacheValid && cacheThin !== thin) cacheValid = false;
        if (!cacheValid) buildScene(thin);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        ctx.save();
        ctx.translate(tx, ty);
        ctx.scale(scale, scale);
        ctx.drawImage(offscreen, 0, 0, cssW, cssH);
        ctx.restore();
    }

    // Crisp settled path: render vectors straight to the visible canvas at the
    // current zoom (so arcs/dots stay sharp when zoomed in). Used on data change
    // and once a pan/zoom gesture settles.
    function drawDirect() {
        if (!img) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        ctx.save();
        ctx.translate(tx, ty);
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, cssW, cssH);
        paintVectors(ctx, wantThin());
        ctx.restore();
    }

    // One rAF coalesces a burst of events into a single frame. 'direct' (crisp)
    // takes precedence over 'composite' (fast blit) when both are requested.
    let rafId = 0;
    let pendingMode = null;
    function schedule(mode) {
        if (mode === 'direct' || pendingMode !== 'direct') pendingMode = mode;
        if (!rafId) rafId = requestAnimationFrame(flush);
    }
    function flush() {
        rafId = 0;
        const mode = pendingMode; pendingMode = null;
        measure();
        clampPan();
        if (mode === 'direct') drawDirect();
        else composite();
    }
    // Scene changed (data/selection/size): drop the cache and redraw crisp.
    function invalidate() { cacheValid = false; schedule('direct'); }
    // Public draw entry point — always a crisp full redraw.
    function draw() { schedule('direct'); }

    // After a pan/zoom gesture stops, repaint crisp (the in-motion frames blit
    // the base-resolution cache, which softens when magnified).
    let settleTimer = 0;
    function scheduleSettle() {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => { settleTimer = 0; schedule('direct'); }, 160);
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
        schedule('composite');   // fast blit while zooming...
        scheduleSettle();        // ...then a crisp repaint once it stops
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
        schedule('composite');   // fast blit while dragging
    });
    const endDrag = e => {
        if (!dragging) return;
        dragging = false;
        try { canvas.releasePointerCapture(e.pointerId); } catch {}
        canvas.style.cursor = scale > 1 ? 'grab' : 'default';
        schedule('direct');      // crisp repaint after the pan settles
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    // Click selects a dot — unless the pointer was dragged (a pan).
    // Clicking empty space (no dot) deselects the current city.
    canvas.addEventListener('click', e => {
        if (moved) { moved = false; return; }
        const rect = canvas.getBoundingClientRect();
        const hit = findDot(e.clientX - rect.left, e.clientY - rect.top);
        if (onSelect) onSelect(hit ? hit.a.id : null);
    });

    const ro = new ResizeObserver(() => draw());
    ro.observe(container);

    return {
        setData(net) {
            airports = net.airports || [];
            const pops = airports.map(a => (a.metrics && a.metrics.population) || 0).filter(v => v > 0);
            popDomain = pops.length ? [Math.min(...pops), Math.max(...pops)] : [1, 1];
            setBackdrop(net.map);
            invalidate();
        },
        update({ visibleRoutes, selectedId: sel }) {
            routes = visibleRoutes || [];
            selectedId = sel || null;
            invalidate();   // scene changed -> drop cache so the next pan blits fresh
        },
        focus() { /* 2D map shows the whole world; nothing to pan. */ },
        resize() { draw(); },
        destroy() {
            ro.disconnect();
            if (rafId) cancelAnimationFrame(rafId);
            if (settleTimer) clearTimeout(settleTimer);
            container.innerHTML = '';
        }
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
