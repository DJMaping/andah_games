// Andah Flight Cities Editor.
//
// A manual relabelling tool for data/flight-cities.json. It loads every tagged
// airport, lists them in a scrollable table with editable City + Nation fields,
// and shows the political map beside the list so you can see WHERE each airport
// sits (click a row to centre its dot; click a dot to jump to its row).
//
// "Reset to City 1…N" replaces every name with a numbered placeholder and blanks
// every nation, so the live tracker shows neutral labels while you relabel by
// hand. Work autosaves to localStorage; "Download flight-cities.json" writes the
// full file back out — save it over data/flight-cities.json to publish it.

const DATA_PATH = 'data/flight-cities.json';
const MAP_IMG = 'maps/andah-political.png';
const STORAGE_KEY = 'andah-flight-cities-editor-v1';

// Population bands -> reference dot colours (RGB), matching the tagger legend.
const BAND_COLORS = {
    '>20M': [160, 32, 240],   // purple
    '10-20M': [230, 30, 30],  // red
    '5-10M': [245, 200, 0],   // gold
    '1-5M': [0, 210, 60]      // green
};

const els = {
    list: document.getElementById('fce-list'),
    canvas: document.getElementById('fce-canvas'),
    viewport: document.getElementById('fce-map'),
    status: document.getElementById('fce-status'),
    search: document.getElementById('fce-search'),
    progress: document.getElementById('fce-progress'),
    reset: document.getElementById('fce-reset'),
    reload: document.getElementById('fce-reload'),
    exportBtn: document.getElementById('fce-export')
};

const ctx = els.canvas.getContext('2d');

let mapImg = null;
let mapMeta = { image: MAP_IMG };
let airports = [];             // { id, _orig, city, airport, nation, population, band, x, y }
let rowEls = [];
let selected = -1;
let saveTimer = null;

// View transform: screen = native * fit * zoom + (tx, ty); fit = cssW / native.
let zoom = 1, tx = 0, ty = 0;
let fit = 1, cssW = 0, cssH = 0;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// --- init ----------------------------------------------------------------
init();

async function init() {
    const doc = await fetchJson(DATA_PATH);
    if (!doc || !Array.isArray(doc.cities) || !doc.cities.length) {
        showStatus(`Could not load ${DATA_PATH}.`);
        return;
    }
    mapMeta = doc.map || { image: MAP_IMG };

    try {
        mapImg = await loadImage(mapMeta.image || MAP_IMG);
    } catch {
        showStatus(`Could not load the map image: ${mapMeta.image || MAP_IMG}.`);
        return;
    }
    mapMeta.width = mapMeta.width || mapImg.naturalWidth;
    mapMeta.height = mapMeta.height || mapImg.naturalHeight;
    els.status.style.display = 'none';

    const saved = loadSaved();
    airports = (saved && saved.length) ? saved : seedFromDoc(doc);
    if (!saved) persist();

    wireEvents();
    renderList();
    updateProgress();
    draw();
}

// Each city object -> editable row, remembering the original name as a hint.
function seedFromDoc(doc) {
    return doc.cities.map(c => ({
        id: c.id || '',
        _orig: c.city || '',
        city: c.city || '',
        airport: c.airport || c.city || '',
        nation: c.nation || '',
        population: Number.isFinite(c.population) ? c.population : null,
        band: c.band || '1-5M',
        x: c.x,
        y: c.y
    }));
}

// --- list rendering ------------------------------------------------------
function renderList() {
    const frag = document.createDocumentFragment();
    rowEls = [];
    for (let i = 0; i < airports.length; i++) {
        const a = airports[i];
        const row = document.createElement('div');
        row.className = 'fce-row';
        row.dataset.i = String(i);

        const idx = document.createElement('div');
        idx.className = 'fce-idx';
        const num = document.createElement('span');
        num.textContent = '#' + (i + 1);
        const dot = document.createElement('span');
        dot.className = 'fce-dot';
        dot.style.background = bandRgb(a.band);
        idx.append(num, dot);

        const fields = document.createElement('div');
        fields.className = 'fce-fields';
        const name = document.createElement('input');
        name.className = 'fce-name';
        name.placeholder = 'City name';
        name.autocomplete = 'off';
        name.value = a.city || '';
        const nation = document.createElement('input');
        nation.className = 'fce-nation';
        nation.placeholder = 'Nation';
        nation.autocomplete = 'off';
        nation.value = a.nation || '';
        const meta = document.createElement('div');
        meta.className = 'fce-meta';
        meta.textContent = metaText(a);
        fields.append(name, nation, meta);

        row.append(idx, fields);
        if (isLabelled(a)) row.classList.add('done');
        frag.appendChild(row);
        rowEls[i] = row;
    }
    els.list.replaceChildren(frag);
    if (els.search.value) applyFilter(els.search.value);
}

function metaText(a) {
    const pop = a.population ? a.population.toLocaleString() : '—';
    const was = a._orig ? ` · was: ${a._orig}` : '';
    return `${a.band || '?'} · pop ${pop}${was}`;
}

// "Done" = has a real (non-placeholder) name AND a nation.
function isLabelled(a) {
    return !!(a.city && !/^City\s+\d+$/.test(a.city.trim()) && a.nation && a.nation.trim());
}

// --- map rendering -------------------------------------------------------
function recomputeFit() {
    cssW = els.viewport.clientWidth || 900;
    cssH = els.viewport.clientHeight || 500;
    fit = cssW / mapImg.naturalWidth;
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

    for (let i = 0; i < airports.length; i++) {
        const a = airports[i];
        if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
        const [x, y] = nativeToScreen(a.x, a.y);
        if (x < -10 || y < -10 || x > cssW + 10 || y > cssH + 10) continue;
        const labelled = isLabelled(a);
        ctx.beginPath();
        ctx.arc(x, y, i === selected ? 7 : 5, 0, Math.PI * 2);
        ctx.fillStyle = labelled ? bandRgb(a.band) : 'rgba(255,255,255,0.45)';
        ctx.strokeStyle = i === selected ? '#fff' : (labelled ? '#000' : bandRgb(a.band));
        ctx.lineWidth = i === selected ? 3 : 1.5;
        ctx.fill();
        ctx.stroke();
    }
}

function bandRgb(key) {
    const c = BAND_COLORS[key] || BAND_COLORS['1-5M'];
    return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// --- interaction ---------------------------------------------------------
function wireEvents() {
    // List: edit, select, focus.
    els.list.addEventListener('input', onListInput);
    els.list.addEventListener('focusin', e => {
        const row = e.target.closest('.fce-row');
        if (row) selectRow(Number(row.dataset.i), false, true, false);
    });
    els.list.addEventListener('click', e => {
        if (e.target.matches('input')) return;
        const row = e.target.closest('.fce-row');
        if (row) selectRow(Number(row.dataset.i), true, true, true);
    });

    els.search.addEventListener('input', () => applyFilter(els.search.value));
    els.reset.addEventListener('click', resetPlaceholders);
    els.reload.addEventListener('click', reloadFromFile);
    els.exportBtn.addEventListener('click', exportJson);

    // Map: zoom / pan / click a dot.
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
        if (hit >= 0) selectRow(hit, true, false, true);
    });

    new ResizeObserver(() => draw()).observe(els.viewport);
}

function onListInput(e) {
    const row = e.target.closest('.fce-row');
    if (!row) return;
    const i = Number(row.dataset.i);
    const a = airports[i];
    if (e.target.classList.contains('fce-name')) {
        a.city = e.target.value;
        a.airport = e.target.value;
    } else if (e.target.classList.contains('fce-nation')) {
        a.nation = e.target.value;
    }
    row.classList.toggle('done', isLabelled(a));
    scheduleSave();
    updateProgress();
    draw();
}

function findDot(px, py) {
    let hit = -1, best = 12 * 12;
    for (let i = 0; i < airports.length; i++) {
        const a = airports[i];
        if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
        const [x, y] = nativeToScreen(a.x, a.y);
        const dd = (px - x) ** 2 + (py - y) ** 2;
        if (dd < best) { best = dd; hit = i; }
    }
    return hit;
}

// Select a row + its dot. `scrollRow` brings the row into view; `centreMap`
// pans the map to the dot; `focusName` moves the caret into the name input.
function selectRow(i, scrollRow, centreMap, focusName) {
    if (selected >= 0 && rowEls[selected]) rowEls[selected].classList.remove('sel');
    selected = i;
    const row = rowEls[i];
    if (row) {
        row.classList.add('sel');
        if (scrollRow) row.scrollIntoView({ block: 'nearest' });
        if (focusName) { const inp = row.querySelector('.fce-name'); if (inp) inp.focus(); }
    }
    if (centreMap) centerOn(i);
    draw();
}

function centerOn(i) {
    const a = airports[i];
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) { draw(); return; }
    if (zoom < 3) zoom = 4;
    tx = cssW / 2 - a.x * fit * zoom;
    ty = cssH / 2 - a.y * fit * zoom;
    draw();
}

function applyFilter(q) {
    const needle = q.trim().toLowerCase();
    for (let i = 0; i < airports.length; i++) {
        const a = airports[i];
        const hay = `${a.city} ${a.nation} ${a._orig} #${i + 1} city ${i + 1}`.toLowerCase();
        rowEls[i].style.display = (!needle || hay.includes(needle)) ? '' : 'none';
    }
}

// --- progress ------------------------------------------------------------
function updateProgress() {
    const done = airports.filter(isLabelled).length;
    els.progress.textContent = `${done} / ${airports.length} relabelled`;
}

// --- reset / reload ------------------------------------------------------
function resetPlaceholders() {
    if (!confirm('Reset ALL city names to “City 1 … City N” and blank every nation?\n\nYour originals are kept in data/flight-cities.backup.json.')) return;
    for (let i = 0; i < airports.length; i++) {
        airports[i].city = `City ${i + 1}`;
        airports[i].airport = `City ${i + 1}`;
        airports[i].nation = '';
    }
    persist();
    renderList();
    updateProgress();
    draw();
}

async function reloadFromFile() {
    if (!confirm('Discard local edits in this browser and reload data/flight-cities.json from disk?')) return;
    const doc = await fetchJson(DATA_PATH);
    if (!doc || !Array.isArray(doc.cities)) { alert(`Could not reload ${DATA_PATH}.`); return; }
    airports = seedFromDoc(doc);
    selected = -1;
    persist();
    renderList();
    updateProgress();
    draw();
}

// --- persistence + export ------------------------------------------------
function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 250);
}
function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(airports)); } catch {}
}
function loadSaved() {
    try {
        const v = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        return Array.isArray(v) ? v : null;
    } catch { return null; }
}

function slug(s) {
    return String(s).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
}

// Export EVERY airport (placeholders included) so none are dropped from the
// file. Shape matches data/flight-cities.json exactly.
function exportJson() {
    const usedIds = new Set();
    const cities = airports.map((a, i) => {
        const city = (a.city || '').trim() || `City ${i + 1}`;
        const airport = (a.airport || '').trim() || city;
        let base = slug(airport || city) || `city-${i + 1}`;
        let id = base, n = 2;
        while (usedIds.has(id)) id = `${base}-${n++}`;
        usedIds.add(id);
        return {
            id,
            city,
            airport,
            nation: (a.nation || '').trim(),
            population: Number.isFinite(a.population) ? a.population : null,
            band: a.band || null,
            x: Math.round(a.x),
            y: Math.round(a.y)
        };
    });
    const doc = {
        map: { image: mapMeta.image || MAP_IMG, width: mapMeta.width, height: mapMeta.height },
        cities
    };
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'flight-cities.json';
    a.click();
    URL.revokeObjectURL(a.href);
}

// --- utils ---------------------------------------------------------------
async function fetchJson(path) {
    try {
        const res = await fetch(path, { cache: 'no-cache' });
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}
function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}
function showStatus(msg) {
    els.status.textContent = msg;
    els.status.style.display = '';
}
