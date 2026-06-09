// Generic wiki page renderer for /wiki/<slug> (rewritten to /wiki.html?p=<slug>
// by netlify.toml).

export async function renderWikiPage({ container, slug, wikiIndex }) {
    const entry = (wikiIndex?.pages || []).find(p => p.slug === slug);
    if (!entry) {
        container.innerHTML = `
            <h1 class="huge-title">Page not found</h1>
            <p class="result-text">No wiki page for "<code>${escapeHtml(slug)}</code>" was found in the latest build.</p>
            <p class="result-text"><a href="https://andah.miraheze.org/wiki/${encodeURIComponent(slug)}" target="_blank" rel="noopener">View on Miraheze ↗</a></p>
            <p><a href="/wiki/">All pages</a></p>
        `;
        document.title = 'Wiki — Andah';
        return;
    }

    try {
        const res = await fetch(entry.file, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        document.title = `${entry.displaytitle || entry.title} — Andah Wiki`;
        container.innerHTML = `
            <header class="wiki-page-header">
                <h1 class="huge-title">${entry.displaytitle || escapeHtml(entry.title)}</h1>
                <p class="wiki-page-meta">
                    Mirrored from
                    <a href="https://andah.miraheze.org/wiki/${encodeURIComponent(entry.title.replace(/\s+/g, '_'))}" target="_blank" rel="noopener">Andah Wiki ↗</a>
                </p>
            </header>
            <article class="wiki-article">${html}</article>
        `;
    } catch (e) {
        container.innerHTML = `<p class="result-text">Failed to load page: ${escapeHtml(e.message)}</p>`;
    }
}

export function renderWikiIndex({ container, wikiIndex }) {
    const pages = wikiIndex?.pages || [];
    document.title = 'Wiki — Andah';
    container.innerHTML = `
        <h1 class="huge-title">Andah Wiki</h1>
        <p class="subtitle">A live mirror of the <a href="https://andah.miraheze.org" target="_blank" rel="noopener">Andah Miraheze wiki</a>. Editing happens there; this site re-syncs daily.</p>
        <input type="search" class="type-input" id="wiki-search" placeholder="Search pages..." />
        <ul class="wiki-page-list" id="wiki-page-list"></ul>
    `;
    const $list = container.querySelector('#wiki-page-list');
    const $search = container.querySelector('#wiki-search');

    function draw() {
        const q = $search.value.trim().toLowerCase();
        const filtered = q ? pages.filter(p => (p.title || '').toLowerCase().includes(q)) : pages;
        $list.innerHTML = filtered.map(p => `
            <li><a href="/wiki/${encodeURIComponent(p.slug)}">${escapeHtml(p.displaytitle || p.title)}</a></li>
        `).join('') || '<li class="result-text">No matches.</li>';
    }

    $search.addEventListener('input', draw);
    draw();
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
