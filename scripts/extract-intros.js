#!/usr/bin/env node
// Parse a MediaWiki XML dump in mediawiki/ and extract the intro paragraph of
// every Main-namespace page into data/intros.json. The country-detail view on
// the explore page reads this file and shows the intro below the hero.
//
// Usage: node scripts/extract-intros.js
// Picks the most-recently-modified .xml file in mediawiki/.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { toSlug } from './util/slug.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MEDIAWIKI_DIR = path.join(ROOT, 'mediawiki');
const DATA_DIR = path.join(ROOT, 'data');

function findLatestXmlDump() {
    if (!fs.existsSync(MEDIAWIKI_DIR)) return null;
    const candidates = fs.readdirSync(MEDIAWIKI_DIR)
        .filter(f => f.toLowerCase().endsWith('.xml'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(MEDIAWIKI_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    return candidates[0] ? path.join(MEDIAWIKI_DIR, candidates[0].name) : null;
}

function extractPages(xml) {
    const blocks = [];
    let i = 0;
    while (true) {
        const start = xml.indexOf('<page>', i);
        if (start < 0) break;
        const end = xml.indexOf('</page>', start);
        if (end < 0) break;
        blocks.push(xml.slice(start + '<page>'.length, end));
        i = end + '</page>'.length;
    }
    return blocks;
}

function getTag(block, tag) {
    const open = block.indexOf(`<${tag}>`);
    if (open < 0) return null;
    const close = block.indexOf(`</${tag}>`, open);
    if (close < 0) return null;
    return decodeXmlEntities(block.slice(open + tag.length + 2, close));
}

function getLatestText(block) {
    const re = /<text[^>]*xml:space="preserve">([\s\S]*?)<\/text>/g;
    let m;
    let last = null;
    while ((m = re.exec(block)) !== null) last = m[1];
    return last == null ? '' : decodeXmlEntities(last);
}

function decodeXmlEntities(s) {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');
}

function extractIntro(wikitext) {
    if (!wikitext) return '';
    if (/^\s*#REDIRECT/i.test(wikitext)) return '';

    let text = wikitext;

    // Strip HTML-style refs and comments (before stripping templates, because
    // refs sometimes contain templates that would confuse the brace matcher).
    text = text.replace(/<ref[^>]*\/>/g, '');
    text = text.replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/g, '');
    text = text.replace(/<!--[\s\S]*?-->/g, '');

    // Strip templates iteratively: match the innermost {{...}} (no braces
    // inside) and remove. Repeat until none remain. Handles nested templates.
    let prev;
    let guard = 0;
    do {
        prev = text;
        text = text.replace(/\{\{[^{}]*\}\}/g, '');
        guard++;
    } while (text !== prev && guard < 20);

    // Cut at the first section heading (== Section ==).
    const headingMatch = text.match(/^==/m);
    if (headingMatch) text = text.slice(0, headingMatch.index);

    // Strip magic words like __NOTOC__.
    text = text.replace(/__[A-Z]+__/g, '');

    // [[Link|Display]] -> Display; [[Link]] -> Link.
    text = text.replace(/\[\[([^\]\|]+)\|([^\]]+)\]\]/g, '$2');
    text = text.replace(/\[\[([^\]]+)\]\]/g, '$1');

    // External links: [http://url Display] -> Display; [http://url] -> url.
    text = text.replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1');
    text = text.replace(/\[(https?:\/\/\S+)\]/g, '$1');

    // Strip bold/italic apostrophe markers.
    text = text.replace(/'{2,5}/g, '');

    // Remove leftover HTML tags.
    text = text.replace(/<\/?[^>]+>/g, '');

    // Drop any leftover table rows or pipe-syntax fragments at the start.
    text = text.replace(/^\s*\|[^\n]*\n/gm, '');

    // First non-empty paragraph (blocks separated by blank lines).
    const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    const first = paragraphs[0] || '';

    return first.replace(/\s+/g, ' ').trim();
}

export async function extractIntros() {
    const xmlPath = findLatestXmlDump();
    if (!xmlPath) {
        console.warn('No XML dump found in mediawiki/; skipping intros.');
        return { written: 0 };
    }
    console.log(`Reading ${path.relative(ROOT, xmlPath)}...`);
    const xml = fs.readFileSync(xmlPath, 'utf8');
    const blocks = extractPages(xml);
    console.log(`Found ${blocks.length} <page> blocks.`);

    const intros = [];
    for (const block of blocks) {
        const ns = getTag(block, 'ns');
        if (ns !== '0') continue;
        const title = getTag(block, 'title');
        if (!title) continue;
        const wikitext = getLatestText(block);
        const intro = extractIntro(wikitext);
        if (!intro) continue;
        intros.push({
            slug: toSlug(title),
            title,
            intro
        });
    }

    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = {
        generatedAt: new Date().toISOString(),
        source: path.basename(xmlPath),
        pages: intros.sort((a, b) => a.title.localeCompare(b.title))
    };
    fs.writeFileSync(
        path.join(DATA_DIR, 'intros.json'),
        JSON.stringify(out, null, 2)
    );
    console.log(`Wrote ${intros.length} intros to data/intros.json.`);
    return { written: intros.length };
}

const isMain = (() => {
    try {
        return import.meta.url === url.pathToFileURL(process.argv[1]).href;
    } catch {
        return false;
    }
})();

if (isMain) {
    extractIntros().catch(e => {
        console.error(e);
        process.exit(1);
    });
}
