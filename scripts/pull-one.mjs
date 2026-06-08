// One-off: pull a single Main-namespace page from the Andah wiki, clean it,
// and write wiki/<slug>.html (updating data/wiki-index.json if present).
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { cleanWikiHtml } from './util/wiki-clean.js';
import { toSlug, fromWikiTitle } from './util/slug.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WIKI_DIR = path.join(ROOT, 'wiki');
const DATA_DIR = path.join(ROOT, 'data');

const API = 'https://andah.miraheze.org/w/api.php';
const UA = process.env.MIRAHEZE_USER_AGENT || 'AndahGames/0.1 (https://www.djmapping.com; contact: github)';

// Accept one or more page titles; dedupe while preserving order.
const titles = [...new Set(process.argv.slice(2).map(t => t.trim()).filter(Boolean))];
if (!titles.length) titles.push('Oyreain');

async function apiGet(params) {
    const qs = new URLSearchParams({ format: 'json', formatversion: '2', ...params }).toString();
    const res = await fetch(`${API}?${qs}`, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`API ${res.status} ${res.statusText}`);
    return res.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(WIKI_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

function textChars(cleaned) {
    return cleaned
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#160;|&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim().length;
}

for (const pageTitle of titles) {
    try {
        const data = await apiGet({
            action: 'parse', page: pageTitle,
            prop: 'text|revid|categories|displaytitle', redirects: '1'
        });
        if (!data?.parse) throw new Error('no parse result');
        const parse = data.parse;
        const cleaned = cleanWikiHtml(parse.text || '');
        const slug = toSlug(fromWikiTitle(parse.title));
        fs.writeFileSync(path.join(WIKI_DIR, `${slug}.html`), cleaned, 'utf8');
        console.log(`OK   ${pageTitle}  ->  wiki/${slug}.html  (revid ${parse.revid}, ${cleaned.length}B html, ~${textChars(cleaned)} text chars)`);
    } catch (e) {
        console.log(`FAIL ${pageTitle}  ->  ${e.message}`);
    }
    await sleep(50);
}
