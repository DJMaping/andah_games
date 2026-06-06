// Strip MediaWiki chrome from parsed HTML and rewrite internal links so they
// resolve against this site (/wiki/<slug>) instead of /wiki/<Title>.

import * as cheerio from 'cheerio';
import { toSlug, fromWikiTitle } from './slug.js';

const SOURCE_ORIGIN = 'https://andah.miraheze.org';

const REMOVE_SELECTORS = [
    '.mw-editsection',
    '.mw-jump-link',
    '.noprint',
    '.printfooter',
    '.mw-indicators',
    'script',
    'style',
    '.mw-empty-elt'
];

export function cleanWikiHtml(rawHtml) {
    const $ = cheerio.load(rawHtml, { decodeEntities: false }, false);

    for (const sel of REMOVE_SELECTORS) $(sel).remove();

    // Rewrite internal /wiki/<Title> links to local slug routes.
    $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (href.startsWith('/wiki/')) {
            const rest = href.slice('/wiki/'.length);
            // Skip non-main-namespace links (Category:, File:, etc.) -- leave as external.
            if (/^[A-Z][a-zA-Z]+:/.test(rest)) {
                $(el).attr('href', SOURCE_ORIGIN + href);
                $(el).attr('target', '_blank');
                $(el).attr('rel', 'noopener');
                return;
            }
            const [titleEncoded, hash] = rest.split('#');
            const title = decodeURIComponent(titleEncoded);
            const slug = toSlug(fromWikiTitle(title));
            $(el).attr('href', `/wiki/${slug}${hash ? '#' + hash : ''}`);
        } else if (href.startsWith('//')) {
            $(el).attr('href', 'https:' + href);
        } else if (href.startsWith('/')) {
            // Any other site-relative link points back at Miraheze.
            $(el).attr('href', SOURCE_ORIGIN + href);
            $(el).attr('target', '_blank');
            $(el).attr('rel', 'noopener');
        }
    });

    // Absolutize protocol-relative image sources.
    $('img[src]').each((_, el) => {
        const src = $(el).attr('src') || '';
        if (src.startsWith('//')) {
            $(el).attr('src', 'https:' + src);
        } else if (src.startsWith('/')) {
            $(el).attr('src', SOURCE_ORIGIN + src);
        }
        // Lazy-loading for off-screen images.
        if (!$(el).attr('loading')) $(el).attr('loading', 'lazy');
    });

    // Drop fully-empty paragraphs.
    $('p').each((_, el) => {
        if ($(el).text().trim() === '' && $(el).children().length === 0) {
            $(el).remove();
        }
    });

    return $.html();
}
