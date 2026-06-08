// Andah Flight Airport Tagger.
//
// A temporary data-entry tool: it auto-detects the city dots in
// maps/andah-city-dots.png (one per city, coloured by population band), overlays
// them on the political map, and lets you click each to assign a city name +
// nation. Double-click empty space to add an extra airport (for big cities).
// Work autosaves to localStorage; export writes data/flight-cities.json, which
// the flight network then consumes. When this browser has no saved work, the
// tagger restores from the committed data/flight-cities.json (and the Import
// button reloads any exported file), so progress survives across machines.

import { loadCities } from '../views/data.js';

const MAP_IMG = 'maps/andah-political.png';
const DOTS_IMG = 'maps/andah-city-dots.png';
const STORAGE_KEY = 'andah-flight-tagger-v1';

// Population bands from the legend, with reference dot colours (RGB) and the
// expected dot counts so detection can be sanity-checked.
const BANDS = [
    { key: '>20M', color: [160, 32, 240], expected: 6 },     // purple
    { key: '10-20M', color: [230, 30, 30], expected: 27 },   // red
    { key: '5-10M', color: [245, 200, 0], expected: 53 },    // gold
    { key: '1-5M', color: [0, 210, 60], expected: 516 }      // green
];
const bandByKey = Object.fromEntries(BANDS.map(b => [b.key, b]));

const els = {
    canvas: document.getElementById('tag-canvas'),
    viewport: document.querySelector('.tagger-viewport'),
    status: document.getElementById('tag-status'),
    counts: document.getElementById('tag-counts'),
    form: document.getElementById('tag-form'),
    band: document.getElementById('tag-band'),
    name: document.getElementById('tag-name'),
    nation: document.getElementById('tag-nation'),
    pop: document.getElementById('tag-pop'),
    airport: document.getElementById('tag-airport'),
    cityList: document.getElementById('tag-city-list'),
    nationList: document.getElementById('tag-nation-list'),
    save: document.getElementById('tag-save'),
    del: document.getElementById('tag-delete'),
    detect: document.getElementById('tag-detect'),
    onlyUnassigned: document.getElementById('tag-show-unassigned'),
    progress: document.getElementById('tag-progress'),
    exportBtn: document.getElementById('tag-export'),
    importBtn: document.getElementById('tag-import'),
    importFile: document.getElementById('tag-import-file'),
    clearBtn: document.getElementById('tag-clear')
};

const ctx = els.canvas.getContext('2d');

let mapImg = null;
let dotsImg = null;
let cities = [];               // { name, country, population }
let cityByName = new Map();
let nations = [];

let dots = [];                 // { x, y (native px), band, name, nation, population, airport, manual }
let selected = -1;

// View transform: screen = nativeFit * zoom + (tx, ty); nativeFit = native * fit.
let zoom = 1, tx = 0, ty = 0;
let fit = 1, cssW = 0, cssH = 0;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// --- init ----------------------------------------------------------------
init();

async function init() {
    const cityData = await loadCities();
    cities = (cityData || []).slice().sort((a, b) => b.population - a.population);
    cityByName = new Map(cities.map(c => [c.name.toLowerCase(), c]));
    nations = [...new Set(cities.map(c => c.country))].sort();
    els.nationList.innerHTML = nations.map(n => `<option value="${esc(n)}"></option>`).join('');

    try {
        [mapImg, dotsImg] = await Promise.all([loadImage(MAP_IMG), loadImage(DOTS_IMG)]);
    } catch {
        els.status.textContent = `Save the images first: ${MAP_IMG} and ${DOTS_IMG}.`;
        return;
    }
    els.status.style.display = 'none';

    const saved = loadSaved();
    if (saved && saved.length) {
        dots = saved;
    } else {
        // Nothing in this browser — fall back to the committed export so prior
        // progress resumes on a fresh machine / origin / after a data wipe.
        dots = detectDots(dotsImg);
        const doc = await fetchExport();
        if (doc) {
            applyExport(dots, doc);
            flashStatus(`Restored ${doc.cities.length} cities from data/flight-cities.json`);
        }
        persist();
    }

    wireEvents();
    draw();
    refreshCounts();
    renderProgress();
}

// --- dot detection -------------------------------------------------------
function detectDots(img) {
    // Higher scan resolution separates dense dot clusters better. The per-band
    // expected-count check surfaces any dots that still merge.
    const scale = Math.min(1, 6000 / img.naturalWidth);
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const octx = off.getContext('2d', { willReadFrequently: true });
    octx.drawImage(img, 0, 0, w, h);
    const data = octx.getImageData(0, 0, w, h).data;

    const seen = new Uint8Array(w * h);
    const colored = i => {
        const o = i * 4;
        if (data[o + 3] < 128) return false;
        return (255 - data[o]) + (255 - data[o + 1]) + (255 - data[o + 2]) > 90;
    };

    const found = [];
    const stack = [];
    for (let p = 0; p < w * h; p++) {
        if (seen[p]) continue;
        seen[p] = 1;
        if (!colored(p)) continue;
        stack.length = 0;
        stack.push(p);
        let sx = 0, sy = 0, n = 0, sr = 0, sg = 0, sb = 0;
        while (stack.length) {
            const q = stack.pop();
            const qx = q % w, qy = (q - qx) / w;
            sx += qx; sy += qy; n++;
            sr += data[q * 4]; sg += data[q * 4 + 1]; sb += data[q * 4 + 2];
            const nbs = [qx > 0 ? q - 1 : -1, qx < w - 1 ? q + 1 : -1, qy > 0 ? q - w : -1, qy < h - 1 ? q + w : -1];
            for (const nb of nbs) {
                if (nb < 0 || seen[nb]) continue;
                seen[nb] = 1;
                if (colored(nb)) stack.push(nb);
            }
        }
        if (n < 2) continue;          // ignore single-pixel speckle
        found.push({
            x: (sx / n) / scale,
            y: (sy / n) / scale,
            band: classifyBand([sr / n, sg / n, sb / n]),
            name: '', nation: '', population: null, airport: '', manual: false
        });
    }
    return found;
}

function classifyBand(rgb) {
    let best = BANDS[0], bestD = Infinity;
    for (const b of BANDS) {
        const d = (rgb[0] - b.color[0]) ** 2 + (rgb[1] - b.color[1]) ** 2 + (rgb[2] - b.color[2]) ** 2;
        if (d < bestD) { bestD = d; best = b; }
    }
    return best.key;
}

// --- rendering -----------------------------------------------------------
function recomputeFit() {
    cssW = els.viewport.clientWidth || 900;
    cssH = els.viewport.clientHeight || 500;
    fit = cssW / mapImg.naturalWidth;             // native -> base CSS px (zoom 1 fills width)
}

function clampPan() {
    const w = mapImg.naturalWidth * fit * zoom;
    const h = mapImg.naturalHeight * fit * zoom;
    tx = clamp(tx, Math.min(0, cssW - w), 0);
    ty = clamp(ty, Math.min(0, cssH - h), 0);
}

function nativeToScreen(nx, ny) { return [nx * fit * zoom + tx, ny * fit * zoom + ty]; }
function screenToNative(px, py) { return [((px - tx) / zoom) / fit, ((py - ty) / zoom) / fit]; }

function draw() {
    if (!mapImg) return;
    recomputeFit();
    clampPan();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    els.canvas.width = Math.round(cssW * dpr);
    els.canvas.height = Math.round(cssH * dpr);
    els.canvas.style.width = cssW + 'px';
    els.canvas.style.height = cssH + 'px';

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(zoom, zoom);
    ctx.drawImage(mapImg, 0, 0, mapImg.naturalWidth * fit, mapImg.naturalHeight * fit);
    ctx.restore();

    // Markers in screen space → constant size regardless of zoom.
    const onlyUn = els.onlyUnassigned.checked;
    for (let i = 0; i < dots.length; i++) {
        const d = dots[i];
        if (onlyUn && d.name) continue;
        const [x, y] = nativeToScreen(d.x, d.y);
        if (x < -10 || y < -10 || x > cssW + 10 || y > cssH + 10) continue;
        const col = bandRgb(d.band);
        ctx.beginPath();
        ctx.arc(x, y, i === selected ? 7 : 5, 0, Math.PI * 2);
        ctx.fillStyle = d.name ? col : 'rgba(255,255,255,0.4)';
        ctx.strokeStyle = i === selected ? '#fff' : (d.name ? '#000' : col);
        ctx.lineWidth = i === selected ? 3 : 1.5;
        ctx.fill();
        ctx.stroke();
    }
}

function bandRgb(key) {
    const b = bandByKey[key] || BANDS[3];
    return `rgb(${b.color[0]},${b.color[1]},${b.color[2]})`;
}

// --- interaction ---------------------------------------------------------
function wireEvents() {
    let dragging = false, moved = false, lx = 0, ly = 0;

    els.canvas.addEventListener('wheel', e => {
        e.preventDefault();
        const r = els.canvas.getBoundingClientRect();
        const px = e.clientX - r.left, py = e.clientY - r.top;
        const [nx, ny] = screenToNative(px, py);
        zoom = clamp(zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), 1, 40);
        tx = px - nx * fit * zoom;
        ty = py - ny * fit * zoom;
        draw();
    }, { passive: false });

    els.canvas.addEventListener('pointerdown', e => {
        dragging = true; moved = false; lx = e.clientX; ly = e.clientY;
        els.canvas.setPointerCapture(e.pointerId);
    });
    els.canvas.addEventListener('pointermove', e => {
        if (!dragging) return;
        const dx = e.clientX - lx, dy = e.clientY - ly;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        tx += dx; ty += dy; lx = e.clientX; ly = e.clientY;
        draw();
    });
    const end = e => { dragging = false; try { els.canvas.releasePointerCapture(e.pointerId); } catch {} };
    els.canvas.addEventListener('pointerup', end);
    els.canvas.addEventListener('pointercancel', end);

    els.canvas.addEventListener('click', e => {
        if (moved) { moved = false; return; }
        const r = els.canvas.getBoundingClientRect();
        const hit = findDot(e.clientX - r.left, e.clientY - r.top);
        if (hit >= 0) selectDot(hit);
    });
    els.canvas.addEventListener('dblclick', e => {
        const r = els.canvas.getBoundingClientRect();
        const [nx, ny] = screenToNative(e.clientX - r.left, e.clientY - r.top);
        dots.push({ x: nx, y: ny, band: '1-5M', name: '', nation: '', population: null, airport: '', manual: true });
        persist();
        selectDot(dots.length - 1);
        draw();
    });

    els.detect.addEventListener('click', () => {
        const fresh = detectDots(dotsImg);
        // Carry over existing labels to the nearest fresh dot.
        for (const old of dots) {
            if (!old.name && !old.manual) continue;
            let bi = -1, bd = Infinity;
            for (let i = 0; i < fresh.length; i++) {
                const dd = (fresh[i].x - old.x) ** 2 + (fresh[i].y - old.y) ** 2;
                if (dd < bd) { bd = dd; bi = i; }
            }
            if (old.manual && bd > 400 ** 2) { fresh.push(old); continue; }
            if (bi >= 0) Object.assign(fresh[bi], { name: old.name, nation: old.nation, population: old.population, airport: old.airport });
        }
        dots = fresh;
        selected = -1;
        persist(); draw(); refreshCounts(); renderProgress();
    });

    els.onlyUnassigned.addEventListener('change', draw);
    els.name.addEventListener('input', onNameInput);
    els.name.addEventListener('keydown', e => {
        // Enter in the City name box: save, then leave the selected airport.
        if (e.key !== 'Enter') return;
        e.preventDefault();
        saveSelected();
        deselect();
    });
    els.save.addEventListener('click', saveSelected);
    els.del.addEventListener('click', deleteSelected);
    els.exportBtn.addEventListener('click', exportJson);
    els.importBtn.addEventListener('click', () => els.importFile.click());
    els.importFile.addEventListener('change', onImportFile);
    els.clearBtn.addEventListener('click', clearAll);

    new ResizeObserver(() => draw()).observe(els.viewport);
}

function findDot(px, py) {
    let hit = -1, best = 12 * 12;
    const onlyUn = els.onlyUnassigned.checked;
    for (let i = 0; i < dots.length; i++) {
        if (onlyUn && dots[i].name) continue;
        const [x, y] = nativeToScreen(dots[i].x, dots[i].y);
        const dd = (px - x) ** 2 + (py - y) ** 2;
        if (dd < best) { best = dd; hit = i; }
    }
    return hit;
}

function selectDot(i) {
    selected = i;
    const d = dots[i];
    els.form.hidden = false;
    els.band.textContent = `Band: ${d.band}`;
    els.band.style.color = bandRgb(d.band);
    // Narrow the city datalist to this band. Value-only options so the dropdown
    // suggests city names alone — the nation is filled in automatically once a
    // city is chosen (see onNameInput), instead of cluttering each suggestion.
    els.cityList.innerHTML = citiesInBand(d.band)
        .map(c => `<option value="${esc(c.name)}"></option>`).join('');
    els.name.value = d.name || '';
    els.nation.value = d.nation || '';
    els.pop.value = d.population ?? '';
    els.airport.value = d.airport || '';
    els.name.focus();
    draw();
}

function onNameInput() {
    const c = cityByName.get(els.name.value.trim().toLowerCase());
    if (c) {
        els.nation.value = c.country;
        els.pop.value = c.population;
    }
}

function saveSelected() {
    if (selected < 0) return;
    const d = dots[selected];
    d.name = els.name.value.trim();
    d.nation = els.nation.value.trim();
    d.population = els.pop.value ? Number(els.pop.value) : null;
    d.airport = els.airport.value.trim();
    persist();
    refreshCounts(); renderProgress();
    draw();   // reflect the now-labelled dot; stay on the same airport.
}

function deleteSelected() {
    if (selected < 0) return;
    dots.splice(selected, 1);
    selected = -1;
    els.form.hidden = true;
    persist(); draw(); refreshCounts(); renderProgress();
}

// Clear the current selection and close the form (no navigation).
function deselect() {
    selected = -1;
    els.form.hidden = true;
    draw();
}

function selectNextUnassigned() {
    for (let k = 1; k <= dots.length; k++) {
        const i = (selected + k) % dots.length;
        if (!dots[i].name) { selectDot(i); centerOn(i); return; }
    }
    els.form.hidden = true;
    selected = -1;
    draw();
}

function centerOn(i) {
    const d = dots[i];
    if (zoom < 3) zoom = 4;
    tx = cssW / 2 - d.x * fit * zoom;
    ty = cssH / 2 - d.y * fit * zoom;
    draw();
}

function citiesInBand(key) {
    const ranges = { '>20M': [20_000_001, Infinity], '10-20M': [10_000_000, 20_000_000], '5-10M': [5_000_000, 9_999_999], '1-5M': [0, 4_999_999] };
    const [lo, hi] = ranges[key] || [0, Infinity];
    const used = new Set(dots.filter((d, i) => i !== selected && d.name).map(d => d.name.toLowerCase()));
    return cities.filter(c => c.population >= lo && c.population <= hi && !used.has(c.name.toLowerCase()));
}

// --- progress / counts ---------------------------------------------------
function refreshCounts() {
    const assigned = dots.filter(d => d.name).length;
    els.counts.textContent = `${assigned}/${dots.length} labelled`;
}

function renderProgress() {
    els.progress.innerHTML = BANDS.map(b => {
        const detected = dots.filter(d => d.band === b.key).length;
        const done = dots.filter(d => d.band === b.key && d.name).length;
        const warn = detected !== b.expected ? ` <span class="tagger-danger">(expected ${b.expected})</span>` : '';
        return `<div class="tagger-prog-row">
            <span class="haul-dot" style="background:${bandRgb(b.key)}"></span>
            <span>${b.key}</span>
            <span>${done}/${detected}${warn}</span>
        </div>`;
    }).join('');
}

// --- persistence + export ------------------------------------------------
function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(dots)); } catch {}
}
function loadSaved() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; }
}

function clearAll() {
    if (!confirm('Clear ALL tagging progress in this browser?')) return;
    dots = detectDots(dotsImg);
    selected = -1;
    els.form.hidden = true;
    persist(); draw(); refreshCounts(); renderProgress();
}

function slug(s) {
    return String(s).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
}

function exportJson() {
    const labelled = dots.filter(d => d.name && d.nation);
    const usedIds = new Set();
    const out = labelled.map(d => {
        let base = slug(d.airport || d.name);
        let id = base, n = 2;
        while (usedIds.has(id)) id = `${base}-${n++}`;
        usedIds.add(id);
        return {
            id,
            city: d.name,
            airport: d.airport || d.name,
            nation: d.nation,
            population: d.population ?? null,
            band: d.band,
            x: Math.round(d.x),
            y: Math.round(d.y)
        };
    });
    const doc = {
        map: { image: MAP_IMG, width: mapImg.naturalWidth, height: mapImg.naturalHeight },
        cities: out
    };
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'flight-cities.json';
    a.click();
    URL.revokeObjectURL(a.href);
}

// --- import / restore ----------------------------------------------------
// The export is lossy (labelled cities only, no unlabelled dots), so we never
// load it as-is: we re-detect a fresh dot set, then graft each saved city onto
// its nearest detected dot. Cities with no nearby dot (e.g. manually-added
// extra airports) come back as manual dots at their saved coordinates.
function applyExport(target, doc) {
    const used = new Set();
    for (const c of doc.cities) {
        let bi = -1, bd = Infinity;
        for (let i = 0; i < target.length; i++) {
            if (used.has(i)) continue;
            const dd = (target[i].x - c.x) ** 2 + (target[i].y - c.y) ** 2;
            if (dd < bd) { bd = dd; bi = i; }
        }
        const fields = {
            name: c.city || '',
            nation: c.nation || '',
            population: c.population ?? null,
            // exportJson writes airport = d.airport || d.name, so an airport
            // equal to the city name means the original field was blank.
            airport: (c.airport && c.airport !== c.city) ? c.airport : ''
        };
        if (bi >= 0 && bd <= 400 ** 2) {
            Object.assign(target[bi], fields, { band: c.band || target[bi].band });
            used.add(bi);
        } else {
            target.push({ x: c.x, y: c.y, band: c.band || '1-5M', manual: true, ...fields });
        }
    }
    return target;
}

async function fetchExport() {
    try {
        const res = await fetch('data/flight-cities.json', { cache: 'no-store' });
        if (!res.ok) return null;
        const doc = await res.json();
        return doc && Array.isArray(doc.cities) && doc.cities.length ? doc : null;
    } catch { return null; }
}

async function onImportFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';               // let the same file be re-picked later
    if (!file) return;
    let doc;
    try { doc = JSON.parse(await file.text()); }
    catch { alert('That file is not valid JSON.'); return; }
    if (!doc || !Array.isArray(doc.cities) || !doc.cities.length) {
        alert('That is not a flight-cities.json export (no "cities" array).');
        return;
    }
    const labelled = dots.filter(d => d.name).length;
    if (labelled && !confirm(`Replace current progress (${labelled} labelled) with ${doc.cities.length} cities from this file?`)) return;
    dots = applyExport(detectDots(dotsImg), doc);
    selected = -1;
    els.form.hidden = true;
    persist(); draw(); refreshCounts(); renderProgress();
    flashStatus(`Imported ${doc.cities.length} cities`);
}

function flashStatus(msg) {
    els.status.textContent = msg;
    els.status.style.display = '';
    setTimeout(() => { els.status.style.display = 'none'; }, 4000);
}

// --- utils ---------------------------------------------------------------
function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}
function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
