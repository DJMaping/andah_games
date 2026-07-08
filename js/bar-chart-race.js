// bar-chart-race.js — animated "bar chart race" for Andah.
// Top 20 nations by Real GDP per Capita, Andah years 1700–1765.
// Renders to a 1920×1080 <canvas>. Two ways to drive it:
//   • live playback (Play / Restart buttons) + in-page MediaRecorder (Record → .webm)
//   • deterministic capture: window.__seek(seconds) renders one exact frame; used by
//     scripts/render-barrace.mjs to build a frame-accurate MP4.
//
// Data: data/barrace-gdppc.json  { years:[1700..1765], nations:[{name,flag,color,values:{year:$}}] }

const DATA_URL = 'data/barrace-gdppc.json';

// ---- tunables ----
const W = 1920, H = 1080;
const TOP_N = 20;
const SECONDS_PER_YEAR = 1.1;   // transition length between consecutive years
const START_HOLD = 0.8;         // seconds held on the first year
const END_HOLD = 2.6;           // seconds held on the final year
const FPS = 60;                 // used by the deterministic capture path

// layout
const PAD_TOP = 168;
const PAD_BOTTOM = 96;
const AXIS_X = 392;             // bars start here; nation names sit to the left
const AXIS_RIGHT = W - 250;     // leave room for flag + value at the bar tip
const CHART_TOP = PAD_TOP;
const CHART_H = H - PAD_TOP - PAD_BOTTOM;
const ROW_H = CHART_H / TOP_N;
const BAR_H = ROW_H * 0.74;

// colors (light theme, matching the reference)
const BG = '#f3f4f6';
const INK = '#1b1d22';
const MUTED = '#8a9099';
const GRID = '#dfe2e7';

// ---- state ----
let cv, ctx, data, years, nNations, totalYears;
let rankByYear = [];   // rankByYear[k] = Map(name -> rank index, 0 = highest)
let maxByYear = [];     // maxByYear[k] = max value that year
const flagImg = new Map(); // name -> HTMLImageElement (loaded)
let playStart = null, rafId = null, recorder = null, recChunks = [];

// ---- helpers ----
const smoothstep = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
function fmtMoney(v) {
    if (v == null || !isFinite(v)) return '–';
    return '$' + Math.round(v).toLocaleString('en-US');
}
// a "nice" round gridline step near v (1 / 2 / 5 × 10^n)
function niceStep(v) {
    if (v <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / mag;
    const step = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
    return step * mag;
}
// Catmull-Rom: C1-smooth interpolation through p1..p2 given neighbours p0,p3.
// Gives continuous velocity across year boundaries (no per-year stutter/kink).
function catmull(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
function roundRect(x, y, w, h, r) {
    r = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

// ---- data prep ----
async function loadData() {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error('Could not load ' + DATA_URL + ' — run `node scripts/build-barrace.js` first.');
    data = await res.json();
    years = data.years;
    totalYears = years.length;
    nNations = data.nations.length;

    // per-nation value series indexed by year (0 where absent) — for spline interpolation
    for (const n of data.nations) {
        n._series = years.map((y) => n.values[y] ?? 0);
    }

    // per-year ranks + axis max
    for (let k = 0; k < totalYears; k++) {
        const y = years[k];
        const present = data.nations
            .filter((n) => n.values[y] != null)
            .sort((a, b) => b.values[y] - a.values[y]);
        const m = new Map();
        present.forEach((n, i) => m.set(n.name, i));
        // nations missing this year get pushed below the field
        data.nations.forEach((n) => { if (!m.has(n.name)) m.set(n.name, present.length + 50); });
        rankByYear.push(m);
        maxByYear.push(present.length ? present[0].values[y] : 1);
    }
}

function preloadFlags() {
    const jobs = data.nations.map((n) => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => { flagImg.set(n.name, img); resolve(); };
        img.onerror = () => resolve(); // tolerate a missing flag — bar still renders
        img.src = encodeURI(n.flag);
    }));
    return Promise.all(jobs);
}

// ---- timeline ----
// total playable seconds (transitions only); holds are added around it.
function transitionSeconds() { return (totalYears - 1) * SECONDS_PER_YEAR; }
function totalSeconds() { return START_HOLD + transitionSeconds() + END_HOLD; }

// map an absolute time (s) to a fractional year position t in [0, totalYears-1]
function timeToT(sec) {
    const t0 = START_HOLD;
    const t1 = START_HOLD + transitionSeconds();
    if (sec <= t0) return 0;
    if (sec >= t1) return totalYears - 1;
    return (sec - t0) / SECONDS_PER_YEAR;
}

// ---- draw one frame at fractional-year position t ----
function drawT(t) {
    let k = Math.floor(t);
    if (k >= totalYears - 1) k = totalYears - 2;
    if (k < 0) k = 0;
    const frac = Math.min(1, Math.max(0, t - k));
    const barSpan = AXIS_RIGHT - AXIS_X;
    const clampIdx = (i) => (i < 0 ? 0 : i >= totalYears ? totalYears - 1 : i);
    const s0 = clampIdx(k - 1), s1 = k, s2 = k + 1, s3 = clampIdx(k + 2);

    // per-nation smooth value (Catmull-Rom spline) + linear rank; track the leader
    let maxV = 1;
    const rowsAll = [];
    for (const n of data.nations) {
        const v = Math.max(0, catmull(n._series[s0], n._series[s1], n._series[s2], n._series[s3], frac));
        if (v > maxV) maxV = v;
        const rA = rankByYear[k].get(n.name), rB = rankByYear[k + 1].get(n.name);
        const rank = rA + (rB - rA) * frac; // linear → continuous, constant-speed slides
        if (rank < TOP_N + 1.2 && v > 0) rowsAll.push({ n, v, rank });
    }
    // scale is pinned to the current leader: the #1 bar is always 100% width.
    const axisMax = maxV;
    rowsAll.sort((a, b) => b.rank - a.rank); // draw lowest rank last (on top)

    // ---- paint ----
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    // gridlines + axis tick labels (top): round-number ticks up to the leader value
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'center';
    ctx.font = '600 22px Inter, system-ui, Arial, sans-serif';
    const step = niceStep(axisMax / 5);
    for (let val = 0; val <= axisMax + 0.5; val += step) {
        const x = AXIS_X + (val / axisMax) * barSpan;
        ctx.strokeStyle = GRID;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, CHART_TOP - 14);
        ctx.lineTo(x, CHART_TOP + CHART_H + 8);
        ctx.stroke();
        ctx.fillStyle = MUTED;
        ctx.fillText(fmtMoney(val), x, CHART_TOP - 24);
    }

    // clip to chart region so bars slide in/out cleanly
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, CHART_TOP - 2, W, CHART_H + 6);
    ctx.clip();

    // pass 1 — bars (bottom-to-top so the higher-ranked bar overlays during a swap)
    for (const row of rowsAll) {
        const yTop = CHART_TOP + row.rank * ROW_H + (ROW_H - BAR_H) / 2;
        const w = Math.max(2, (row.v / axisMax) * barSpan);
        ctx.fillStyle = row.n.color;
        roundRect(AXIS_X, yTop, w, BAR_H, 7);
        ctx.fill();
    }

    // pass 2 — name + flag + value, drawn top-priority first, suppressing any label
    // that would collide with an already-drawn one (keeps crossings from doubling up text)
    const drawnY = [];
    const LABEL_MIN_GAP = ROW_H * 0.62;
    for (const row of [...rowsAll].sort((a, b) => a.rank - b.rank)) {
        const { n, v, rank } = row;
        const yMid = CHART_TOP + rank * ROW_H + ROW_H / 2;
        if (drawnY.some((y) => Math.abs(y - yMid) < LABEL_MIN_GAP)) continue;
        drawnY.push(yMid);
        const barEnd = AXIS_X + Math.max(2, (v / axisMax) * barSpan);

        // nation name (left of the axis, right-aligned)
        ctx.fillStyle = INK;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.font = '600 30px Inter, system-ui, Arial, sans-serif';
        ctx.fillText(n.name, AXIS_X - 18, yMid);

        // flag at the bar tip
        const img = flagImg.get(n.name);
        const fh = BAR_H * 0.86;
        let fx = barEnd + 14;
        if (img && img.width) {
            const fw = fh * (img.width / img.height);
            ctx.strokeStyle = 'rgba(0,0,0,0.18)';
            ctx.lineWidth = 1;
            ctx.drawImage(img, fx, yMid - fh / 2, fw, fh);
            ctx.strokeRect(fx + 0.5, yMid - fh / 2 + 0.5, fw - 1, fh - 1);
            fx += fw;
        }

        // value label after the flag
        ctx.fillStyle = INK;
        ctx.textAlign = 'left';
        ctx.font = '700 28px Inter, system-ui, Arial, sans-serif';
        ctx.fillText(fmtMoney(v), fx + 14, yMid);
    }
    ctx.restore();

    // ---- title + year counter ----
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = INK;
    ctx.font = '800 46px Inter, system-ui, Arial, sans-serif';
    ctx.fillText('Top 20 Andah Nations', 64, 74);
    ctx.fillStyle = MUTED;
    ctx.font = '600 30px Inter, system-ui, Arial, sans-serif';
    ctx.fillText('Real GDP per Capita', 66, 116);

    // big year, bottom-right (faint, like the reference)
    const dispYear = years[Math.min(totalYears - 1, Math.round(t))];
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(27,29,34,0.14)';
    ctx.font = '800 150px Inter, system-ui, Arial, sans-serif';
    ctx.fillText(String(dispYear), W - 60, H - 54);
}

// ---- live playback ----
function frame(now) {
    if (playStart == null) playStart = now;
    const sec = (now - playStart) / 1000;
    drawT(timeToT(sec));
    if (sec < totalSeconds()) {
        rafId = requestAnimationFrame(frame);
    } else {
        drawT(totalYears - 1);
        rafId = null;
        if (recorder && recorder.state === 'recording') recorder.stop();
    }
}
function play() {
    cancelAnimationFrame(rafId);
    playStart = null;
    rafId = requestAnimationFrame(frame);
}
function stop() { cancelAnimationFrame(rafId); rafId = null; }

// ---- MediaRecorder export (.webm) ----
function record() {
    if (recorder && recorder.state === 'recording') return;
    const stream = cv.captureStream(FPS);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9' : 'video/webm';
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    recChunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    recorder.onstop = () => {
        const blob = new Blob(recChunks, { type: 'video/webm' });
        window.__blob = blob;               // kept for headless byte-extraction
        const url = URL.createObjectURL(blob);
        // Persistent link so a headless driver can save it via `agent-browser download #dllink`.
        let a = document.getElementById('dllink');
        if (!a) {
            a = document.createElement('a');
            a.id = 'dllink';
            a.textContent = 'Download video';
            a.style.position = 'fixed';
            a.style.left = '12px';
            a.style.bottom = '12px';
            document.body.appendChild(a);
        }
        a.href = url;
        a.download = 'andah-gdp-per-capita-1700-1765.webm';
        // Interactive users get an automatic download; headless drivers pull via #dllink.
        if (!navigator.webdriver) a.click();
        window.__videoReady = true;
        window.__done = true;
    };
    window.__done = false;
    recorder.start();
    play();
}

// ---- capture hooks (used by scripts/render-barrace.mjs / agent-browser) ----
// window.__seek(seconds) draws one exact frame; window.__play() runs live playback;
// window.__meta describes the timeline.
function installCaptureAPI() {
    window.__meta = { fps: FPS, duration: totalSeconds(), width: W, height: H };
    window.__seek = (sec) => drawT(timeToT(sec));
    window.__play = play;
    window.__record = record;
    window.__stopRec = () => { if (recorder && recorder.state === 'recording') recorder.stop(); };
    // headless byte-extraction of the recorded webm (base64, chunked)
    window.__blobSize = () => (window.__blob ? window.__blob.size : -1);
    window.__blobChunk = async (start, len) => {
        const slice = window.__blob.slice(start, start + len);
        const bytes = new Uint8Array(await slice.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    };
    // POST the recorded webm to a local sink in one request (used by scripts/render-barrace.mjs)
    window.__upload = async (url) => {
        if (!window.__blob) return 'no-blob';
        const r = await fetch(url, { method: 'POST', body: window.__blob });
        return r.ok ? ('ok ' + window.__blob.size) : ('fail ' + r.status);
    };
    window.__ready = true;
}

// ---- boot ----
async function boot() {
    cv = document.getElementById('race');
    cv.width = W; cv.height = H;
    ctx = cv.getContext('2d');
    ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);

    document.getElementById('btn-play').onclick = play;
    document.getElementById('btn-restart').onclick = play;
    document.getElementById('btn-record').onclick = record;

    // capture mode (?capture=1): chrome-free, canvas fills the viewport
    if (new URLSearchParams(location.search).get('capture')) {
        document.body.classList.add('capture');
    }

    await loadData();
    await preloadFlags();
    installCaptureAPI();
    drawT(0);
    document.getElementById('status').textContent =
        `${nNations} nations · ${years[0]}–${years[totalYears - 1]} · ${totalSeconds().toFixed(1)}s`;
}
boot().catch((e) => {
    const s = document.getElementById('status');
    if (s) s.textContent = e.message;
    console.error(e);
});
