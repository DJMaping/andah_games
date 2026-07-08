// render-barrace.mjs — capture the bar-chart-race canvas to a finished MP4.
//
// Pipeline: a local sink server receives the recorded WebM in one POST; agent-browser
// (bundled Chromium) opens the page, records the canvas via MediaRecorder for the full
// timeline, then POSTs the blob to the sink; ffmpeg transcodes WebM → H.264 MP4.
//
// NOTE: everything here is async on purpose. The sink HTTP server shares this process's
// event loop, so we must never block it (no execSync / Atomics.wait) or the browser's
// upload POST can't be accepted — it would deadlock against the very request we're awaiting.
//
// Prereqs: `npm run serve` (page at http://localhost:3000), agent-browser on PATH, ffmpeg.
// Env: FFMPEG=<path to ffmpeg> (defaults to `ffmpeg`)
//      OUT=<output .mp4 path> (defaults to repo-root/andah-gdp-per-capita-1700-1765.mp4)
//      MAX_SECONDS=<n> to cap recording early (pipeline testing)
//
// Usage: node scripts/render-barrace.mjs

import http from 'node:http';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execAsync = promisify(exec);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = process.env.PAGE || 'http://localhost:3000/bar-chart-race.html';
const PORT = Number(process.env.SINK_PORT || 3011);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const OUT_MP4 = process.env.OUT || path.join(ROOT, 'andah-gdp-per-capita-1700-1765.mp4');
const OUT_WEBM = OUT_MP4.replace(/\.mp4$/i, '.webm');
const MAX_SECONDS = process.env.MAX_SECONDS ? Number(process.env.MAX_SECONDS) : null;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

async function ab(cmd) {
    const { stdout } = await execAsync('agent-browser ' + cmd, { maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
}
async function abeval(js) {
    const out = await ab('eval -b ' + b64(js));
    const line = out.split(/\r?\n/).filter(Boolean).pop() || '';
    return line.replace(/^"|"$/g, '');
}

async function main() {
    // 1) sink server: one POST carries the whole WebM
    let received = null;
    const server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        if (req.method === 'POST') {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                received = Buffer.concat(chunks);
                writeFileSync(OUT_WEBM, received);
                res.writeHead(200); res.end('ok');
            });
            return;
        }
        res.writeHead(404); res.end();
    });
    await new Promise((r) => server.listen(PORT, r));
    console.log(`sink listening on :${PORT}`);

    // 2) open the page fresh (picks up latest JS) and wait for the app
    console.log('opening page…');
    await ab(`open "${PAGE}"`);
    await ab('wait --fn window.__ready===true');
    const duration = parseFloat(await abeval('window.__meta.duration'));
    const width = await abeval('window.__meta.width'), height = await abeval('window.__meta.height');
    console.log(`app ready · ${width}x${height} · timeline ${duration.toFixed(1)}s`);

    // 3) record the canvas for the full timeline
    const recSecs = MAX_SECONDS ? Math.min(MAX_SECONDS, duration) : duration;
    console.log(`recording ${recSecs.toFixed(1)}s…`);
    await abeval('window.__record()');
    await delay(Math.round(recSecs * 1000) + 500);
    await abeval('window.__stopRec()');

    // 4) wait for the blob to finalize, then have the page POST it to the sink
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) { await delay(1000); ready = (await abeval('String(window.__videoReady)')) === 'true'; }
    if (!ready) throw new Error('recording did not finalize (no __videoReady)');
    // fire the upload but don't block on the eval's promise here — the sink (this same
    // event loop) must stay free to accept the POST. Poll `received` instead.
    abeval(`window.__upload("http://localhost:${PORT}/upload")`).then(
        (r) => console.log('upload eval:', r),
        (e) => console.log('upload eval err:', e.message)
    );
    for (let i = 0; i < 120 && !received; i++) await delay(500);
    if (!received) throw new Error('sink never received the video');
    console.log(`received webm: ${(received.length / 1e6).toFixed(1)} MB -> ${OUT_WEBM}`);
    server.close();

    // 5) transcode to MP4 (H.264, yuv420p, faststart)
    console.log('transcoding to MP4…');
    await execAsync(
        `"${FFMPEG}" -y -i "${OUT_WEBM}" -c:v libx264 -pix_fmt yuv420p -crf 18 -preset medium -movflags +faststart "${OUT_MP4}"`,
        { maxBuffer: 16 * 1024 * 1024 }
    );
    const mb = (statSync(OUT_MP4).size / 1e6).toFixed(1);
    try { unlinkSync(OUT_WEBM); } catch { /* keep going if it's locked */ }
    console.log(`\n✓ wrote ${OUT_MP4} (${mb} MB)`);
    try {
        const ffprobe = FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
        const { stdout } = await execAsync(
            `"${ffprobe}" -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate -show_entries format=duration -of default=noprint_wrappers=1 "${OUT_MP4}"`
        );
        console.log(stdout.trim());
    } catch { /* ffprobe optional */ }
    process.exit(0);
}

main().catch((e) => { console.error('render failed:', e.message); process.exit(1); });
