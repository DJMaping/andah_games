// Per-country detail view. Two-column layout: data on the left, embedded wiki
// HTML on the right (or stacked on mobile). Wiki content is the pre-built
// fragment at wiki/<slug>.html.

import { formatValueLong } from './format.js';

export async function renderCountryDetail({ container, country, metricDefs, wikiIndex, onBack }) {
    const def = key => metricDefs.find(d => d.key === key);
    const metricRows = Object.entries(country.metrics || {})
        .filter(([key]) => !def(key)?.hidden)
        .map(([key, value]) => `
            <tr>
                <th scope="row">${escapeHtml(def(key)?.label || key)}</th>
                <td>${escapeHtml(formatValueLong(value, def(key)))}</td>
            </tr>
        `).join('');

    const categoricalRows = Object.entries(country.categorical || {})
        .map(([key, value]) => `
            <tr>
                <th scope="row">${escapeHtml(key)}</th>
                <td>${escapeHtml(value)}</td>
            </tr>
        `).join('');

    const wikiEntry = (wikiIndex?.pages || []).find(p => p.slug === country.slug);

    container.innerHTML = `
        <button type="button" class="back-button" id="detail-back">Back to explore</button>
        <h1 class="huge-title">${escapeHtml(country.name)}</h1>
        <div class="country-detail-grid">
            <section class="detail-data">
                <table class="detail-table">
                    <tbody>
                        ${categoricalRows}
                        ${metricRows}
                    </tbody>
                </table>
                <p class="detail-wiki-link">
                    <a href="https://andah.miraheze.org/wiki/${encodeURIComponent(country.wikiTitle)}" target="_blank" rel="noopener">Edit on Andah Wiki ↗</a>
                </p>
            </section>
            <section class="detail-wiki wiki-article" id="detail-wiki-body">
                <p class="result-text">Loading wiki article...</p>
            </section>
        </div>
    `;

    container.querySelector('#detail-back').addEventListener('click', () => {
        if (onBack) onBack();
    });

    const wikiBody = container.querySelector('#detail-wiki-body');
    if (!wikiEntry) {
        wikiBody.innerHTML = `<p class="result-text">No wiki article found for <strong>${escapeHtml(country.name)}</strong>. <a href="https://andah.miraheze.org/wiki/${encodeURIComponent(country.wikiTitle)}" target="_blank" rel="noopener">Create one ↗</a></p>`;
        return;
    }

    try {
        const res = await fetch(wikiEntry.file, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        wikiBody.innerHTML = html;
    } catch (e) {
        wikiBody.innerHTML = `<p class="result-text">Failed to load wiki article: ${escapeHtml(e.message)}</p>`;
    }
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
