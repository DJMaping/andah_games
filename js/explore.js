// Country Explorer: alphabetical list of all countries. Click one to drill
// into the detail view (visualized stats + embedded wiki article).

import { loadCountries, loadWikiIndex, loadCapitals, loadCities, loadIntros } from '../views/data.js';
import { renderCountryDetail } from '../views/country-detail.js';

const els = {
    list: () => document.getElementById('view-list'),
    detail: () => document.getElementById('view-detail'),
    ul: () => document.getElementById('country-list'),
    subtitle: () => document.getElementById('list-subtitle')
};

let DATA = null;
let WIKI = null;
let CAPITALS = null;
let CITIES = null;
let INTROS = null;

async function init() {
    [DATA, WIKI, CAPITALS, CITIES, INTROS] = await Promise.all([
        loadCountries(),
        loadWikiIndex(),
        loadCapitals(),
        loadCities(),
        loadIntros()
    ]);

    if (DATA._fallback) {
        els.subtitle().innerHTML = 'Showing the country-level dataset from <code>andah-stats.js</code>.';
    }

    window.addEventListener('hashchange', applyHash);
    applyHash();
}

function applyHash() {
    const hash = (window.location.hash || '').replace(/^#/, '');
    const params = new URLSearchParams(hash);
    const country = params.get('country');
    if (country) {
        const match = DATA.countries.find(c => c.slug === country || c.name === country);
        if (match) {
            showDetail(match);
            return;
        }
    }
    showList();
}

function showList() {
    els.detail().hidden = true;
    els.list().hidden = false;
    drawList();
}

async function showDetail(country) {
    els.list().hidden = true;
    els.detail().hidden = false;
    await renderCountryDetail({
        container: els.detail(),
        country,
        allCountries: DATA.countries,
        metricDefs: DATA.metricDefs,
        capitals: CAPITALS,
        cities: CITIES,
        intros: INTROS,
        wikiIndex: WIKI,
        onBack: () => { window.location.hash = ''; }
    });
}

function drawList() {
    const sorted = [...DATA.countries].sort((a, b) => a.name.localeCompare(b.name));
    const ul = els.ul();
    if (sorted.length === 0) {
        ul.innerHTML = '<li class="result-text">No countries available.</li>';
        return;
    }

    ul.innerHTML = sorted.map(c => `
        <li>
            <a class="country-row" href="#country=${encodeURIComponent(c.slug)}" data-slug="${escapeAttr(c.slug)}">
                <img class="country-row-flag" src="flags/${encodeURIComponent(c.name)}.png" alt="" onerror="this.style.visibility='hidden'">
                <span class="country-row-name">${escapeHtml(c.name)}</span>
            </a>
        </li>
    `).join('');
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

init().catch(e => {
    console.error(e);
    document.getElementById('country-list').innerHTML = `<li class="result-text">Failed to load: ${escapeHtml(e.message)}</li>`;
});
