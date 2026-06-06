// Per-country detail view. Visualizes everything we know about a country:
//   - header with flag, name, capital
//   - stat cards for each metric (value + rank + percentile)
//   - rank bars showing where this country sits in the full distribution
//   - largest cities (filtered from andah-cities)
//   - the embedded wiki article (pre-built fragment in wiki/<slug>.html)

import { formatValue, formatValueLong } from './format.js';

export async function renderCountryDetail({
    container,
    country,
    allCountries = [],
    metricDefs = [],
    capitals = [],
    cities = [],
    intros,
    wikiIndex,
    onBack
}) {
    const visibleDefs = metricDefs.filter(d => !d.hidden);

    const capitalEntry = capitals.find(c => c.name === country.name);
    const countryCities = cities
        .filter(c => c.country === country.name)
        .sort((a, b) => b.population - a.population);

    const introEntry = (intros?.pages || []).find(p => p.slug === country.slug || p.title === country.name);
    const wikiEntry = (wikiIndex?.pages || []).find(p => p.slug === country.slug);

    container.innerHTML = `
        <button type="button" class="back-button" id="detail-back">← Back to country list</button>

        <header class="detail-hero">
            <img class="detail-hero-flag" src="flags/${encodeURIComponent(country.name)}.png" alt="" onerror="this.style.display='none'">
            <div class="detail-hero-text">
                <p class="eyebrow">Andah country profile</p>
                <h1 class="huge-title detail-hero-title">${escapeHtml(country.name)}</h1>
                ${capitalEntry ? `<p class="detail-hero-meta">Capital: <strong>${escapeHtml(capitalEntry.capital)}</strong></p>` : ''}
            </div>
        </header>

        ${introEntry ? `<p class="detail-intro">${escapeHtml(introEntry.intro)}</p>` : ''}

        <section class="detail-section">
            <h2 class="detail-section-title">Key statistics</h2>
            <div class="stat-card-grid">
                ${visibleDefs.map(def => renderStatCard(country, def, allCountries)).join('')}
            </div>
        </section>

        <section class="detail-section">
            <h2 class="detail-section-title">Where ${escapeHtml(country.name)} ranks</h2>
            <p class="detail-section-subtitle">Position within all ${allCountries.length} Andah countries — bar shows rank: full bar = #1, empty = last.</p>
            <div class="rank-bar-list">
                ${visibleDefs.map(def => renderRankBar(country, def, allCountries)).join('')}
            </div>
        </section>

        ${renderCategoricalSection(country)}

        ${countryCities.length > 0 ? `
        <section class="detail-section">
            <h2 class="detail-section-title">Largest cities</h2>
            <div class="city-bar-list">
                ${renderCityBars(countryCities)}
            </div>
        </section>` : ''}

        <section class="detail-section">
            <h2 class="detail-section-title">Wiki article</h2>
            <p class="detail-wiki-link">
                <a href="https://andah.miraheze.org/wiki/${encodeURIComponent(country.wikiTitle)}" target="_blank" rel="noopener">Open on Andah Wiki ↗</a>
            </p>
            <div class="wiki-article" id="detail-wiki-body">
                <p class="result-text">Loading wiki article...</p>
            </div>
        </section>
    `;

    container.querySelector('#detail-back').addEventListener('click', () => {
        if (onBack) onBack();
    });

    const wikiBody = container.querySelector('#detail-wiki-body');
    if (!wikiEntry) {
        wikiBody.innerHTML = `<p class="result-text">No wiki article found for <strong>${escapeHtml(country.name)}</strong>. <a href="https://andah.miraheze.org/wiki/${encodeURIComponent(country.wikiTitle)}" target="_blank" rel="noopener">Create one ↗</a></p>`;
    } else {
        try {
            const res = await fetch(wikiEntry.file, { cache: 'no-cache' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            wikiBody.innerHTML = await res.text();
        } catch (e) {
            wikiBody.innerHTML = `<p class="result-text">Failed to load wiki article: ${escapeHtml(e.message)}</p>`;
        }
    }
}

function renderStatCard(country, def, allCountries) {
    const value = country.metrics?.[def.key];
    const { rank, total } = computeRank(country, def, allCountries);

    return `
        <div class="stat-card">
            <div class="stat-card-label">${escapeHtml(def.label || def.key)}</div>
            <div class="stat-card-value">${escapeHtml(formatValue(value, def))}</div>
            ${rank ? `<div class="stat-card-rank">Rank <strong>#${rank}</strong> of ${total}</div>` : ''}
        </div>
    `;
}

function renderRankBar(country, def, allCountries) {
    const value = country.metrics?.[def.key];
    const { rank, total, min, max } = computeRank(country, def, allCountries);
    if (!Number.isFinite(value)) {
        return `
            <div class="rank-bar-row rank-bar-row-empty">
                <div class="rank-bar-label">${escapeHtml(def.label || def.key)}</div>
                <div class="rank-bar-track rank-bar-track-empty"></div>
                <div class="rank-bar-meta"><span class="rank-bar-value">–</span></div>
            </div>
        `;
    }

    // Bar fill = rank position. #1 fills the bar; the last country empties it.
    // A country in the middle of the leaderboard sits at 50%.
    const valuePct = rankToPercent(rank, total);
    const tier = tierFor(rank, total);

    return `
        <div class="rank-bar-row">
            <div class="rank-bar-label">${escapeHtml(def.label || def.key)}</div>
            <div class="rank-bar-track" title="${escapeAttr(formatValueLong(value, def))} — rank #${rank} of ${total}">
                <div class="rank-bar-fill rank-bar-fill-${tier.cls}" style="width: ${valuePct.toFixed(1)}%"></div>
            </div>
            <div class="rank-bar-meta">
                <span class="rank-bar-value">${escapeHtml(formatValue(value, def))}</span>
                <span class="rank-tier rank-tier-${tier.cls}">${escapeHtml(tier.label)}</span>
                <span class="rank-bar-rank">#${rank} / ${total}</span>
            </div>
        </div>
    `;
}

function tierFor(rank, total) {
    if (!rank || !total) return { label: '—', cls: 'mid' };
    const pct = rank / total;
    if (pct <= 0.10) return { label: 'Top 10%', cls: 'top10' };
    if (pct <= 0.25) return { label: 'Top quartile', cls: 'top25' };
    if (pct <= 0.50) return { label: 'Upper half', cls: 'upper' };
    if (pct <= 0.75) return { label: 'Lower half', cls: 'lower' };
    if (pct <= 0.90) return { label: 'Bottom quartile', cls: 'bottom25' };
    return { label: 'Bottom 10%', cls: 'bottom10' };
}

function renderCityBars(countryCities) {
    const top = countryCities.slice(0, 10);
    const max = top[0]?.population || 0;
    return top.map(c => {
        const pct = max > 0 ? Math.max(2, (c.population / max) * 100) : 0;
        return `
            <div class="city-bar-row">
                <div class="city-bar-name">${escapeHtml(c.name)}</div>
                <div class="city-bar-track">
                    <div class="city-bar-fill" style="width: ${pct.toFixed(1)}%"></div>
                </div>
                <div class="city-bar-value">${escapeHtml(formatPopulation(c.population))}</div>
            </div>
        `;
    }).join('');
}

function renderCategoricalSection(country) {
    const entries = Object.entries(country.categorical || {});
    if (entries.length === 0) return '';
    return `
        <section class="detail-section">
            <h2 class="detail-section-title">Other details</h2>
            <table class="detail-table">
                <tbody>
                    ${entries.map(([k, v]) => `
                        <tr>
                            <th scope="row">${escapeHtml(k)}</th>
                            <td>${escapeHtml(v)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </section>
    `;
}

function computeRank(country, def, allCountries) {
    const values = allCountries
        .map(c => c.metrics?.[def.key])
        .filter(v => Number.isFinite(v));
    const sorted = [...values].sort((a, b) => b - a);
    const total = sorted.length;
    const max = sorted[0] || 0;
    const min = sorted[sorted.length - 1] || 0;
    const value = country.metrics?.[def.key];
    if (!Number.isFinite(value) || total === 0) {
        return { rank: null, total, min, max };
    }
    const rank = sorted.indexOf(value) + 1;
    return { rank, total, min, max };
}

function rankToPercent(rank, total) {
    if (!rank || !total) return 0;
    if (total <= 1) return 100;
    // #1 of N → 100%, #N of N → ~0%, middle rank → 50%.
    const pct = ((total - rank) / (total - 1)) * 100;
    return Math.max(2, Math.min(100, pct));
}

function formatPopulation(n) {
    if (!Number.isFinite(n)) return '–';
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return n.toLocaleString();
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
    return escapeHtml(s);
}
