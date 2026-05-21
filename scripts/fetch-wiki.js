#!/usr/bin/env node
// Pull every Main-namespace page from https://andah.miraheze.org via the
// MediaWiki API, clean the HTML, and write one file per page to wiki/<slug>.html.

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
const DELAY_MS = 50;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function apiGet(params) {
    const qs = new URLSearchParams({ format: 'json', formatversion: '2', ...params }).toString();
    const res = await fetch(`${API}?${qs}`, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error(`API ${res.status} ${res.statusText} for ${qs}`);
    return res.json();
}

async function listAllPages() {
    const titles = [];
    let apcontinue = undefined;
    while (true) {
        const data = await apiGet({
            action: 'query',
            list: 'allpages',
            apnamespace: '0',
            aplimit: 'max',
            apfilterredir: 'nonredirects',
            ...(apcontinue ? { apcontinue } : {})
        });
        for (const p of data?.query?.allpages || []) {
            titles.push(p.title);
        }
        const cont = data?.continue?.apcontinue;
        if (!cont) break;
        apcontinue = cont;
        await sleep(DELAY_MS);
    }
    return titles;
}

async function parsePage(title) {
    const data = await apiGet({
        action: 'parse',
        page: title,
        prop: 'text|revid|categories|displaytitle',
        redirects: '1'
    });
    if (!data?.parse) throw new Error(`No parse result for ${title}`);
    const parse = data.parse;
    return {
        title: parse.title,
        displaytitle: parse.displaytitle || parse.title,
        revid: parse.revid,
        categories: (parse.categories || []).map(c => c['*'] || c.category || c).map(String),
        html: parse.text || ''
    };
}

export async function fetchWiki() {
    fs.mkdirSync(WIKI_DIR, { recursive: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });

    console.log('Listing all Main-namespace pages...');
    const titles = await listAllPages();
    console.log(`Found ${titles.length} pages.`);

    const index = [];
    let i = 0;
    for (const title of titles) {
        i++;
        try {
            const page = await parsePage(title);
            const cleaned = cleanWikiHtml(page.html);
            const slug = toSlug(fromWikiTitle(page.title));
            if (!slug) {
                console.warn(`  [${i}/${titles.length}] empty slug for "${title}"; skipping`);
                continue;
            }
            const filePath = path.join(WIKI_DIR, `${slug}.html`);
            fs.writeFileSync(filePath, cleaned, 'utf8');
            index.push({
                slug,
                title: page.title,
                displaytitle: page.displaytitle,
                revid: page.revid,
                categories: page.categories,
                file: path.posix.join('wiki', `${slug}.html`),
                updated: new Date().toISOString()
            });
            if (i % 25 === 0 || i === titles.length) {
                console.log(`  [${i}/${titles.length}] ${page.title}`);
            }
        } catch (e) {
            console.warn(`  [${i}/${titles.length}] FAILED "${title}": ${e.message}`);
        }
        await sleep(DELAY_MS);
    }

    index.sort((a, b) => a.title.localeCompare(b.title));
    fs.writeFileSync(
        path.join(DATA_DIR, 'wiki-index.json'),
        JSON.stringify({ generatedAt: new Date().toISOString(), pages: index }, null, 2)
    );

    console.log(`Wrote ${index.length} wiki page(s) to wiki/ and data/wiki-index.json.`);
}

const isMain = (() => {
    try {
        return import.meta.url === url.pathToFileURL(process.argv[1]).href;
    } catch {
        return false;
    }
})();

if (isMain) {
    fetchWiki().catch(e => {
        console.error(e);
        process.exit(1);
    });
}
