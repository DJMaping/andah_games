// Sortable, filterable country table. Plain DOM, no virtualization.
//
// renderTable({ container, countries, metricDefs, onSelect })
// Re-rendering is idempotent: call again with a different countries array to
// update.

import { formatValue } from './format.js';

const STATE = {
    sortKey: 'name',
    sortDir: 'asc',
    search: ''
};

export function renderTable({ container, countries, metricDefs, categoricalKeys, onSelect, getFilters, setFilters }) {
    const visibleMetricDefs = (metricDefs || []).filter(d => !d.hidden);
    const visibleCategorical = categoricalKeys || [];

    container.innerHTML = `
        <div class="table-controls">
            <input type="search" class="type-input" id="table-search" placeholder="Search countries..." />
        </div>
        <div class="table-scroll">
            <table class="country-table">
                <thead>
                    <tr>
                        <th data-key="name" class="sortable">Country</th>
                        ${visibleCategorical.map(k => `<th data-key="cat:${k}" class="sortable">${escapeHtml(k)}</th>`).join('')}
                        ${visibleMetricDefs.map(d => `<th data-key="m:${d.key}" class="sortable numeric">${escapeHtml(d.label || d.key)}</th>`).join('')}
                    </tr>
                </thead>
                <tbody id="table-body"></tbody>
            </table>
        </div>
    `;

    const search = container.querySelector('#table-search');
    if (getFilters) search.value = getFilters().search || STATE.search;
    search.addEventListener('input', () => {
        STATE.search = search.value;
        if (setFilters) setFilters({ search: search.value });
        draw();
    });

    container.querySelectorAll('th.sortable').forEach(th => {
        th.addEventListener('click', () => {
            const key = th.dataset.key;
            if (STATE.sortKey === key) {
                STATE.sortDir = STATE.sortDir === 'asc' ? 'desc' : 'asc';
            } else {
                STATE.sortKey = key;
                STATE.sortDir = key === 'name' ? 'asc' : 'desc';
            }
            draw();
        });
    });

    function valueFor(country, key) {
        if (key === 'name') return country.name;
        if (key.startsWith('cat:')) return country.categorical?.[key.slice(4)] || '';
        if (key.startsWith('m:')) return country.metrics?.[key.slice(2)];
        return undefined;
    }

    function cmp(a, b, key) {
        const va = valueFor(a, key);
        const vb = valueFor(b, key);
        if (typeof va === 'number' && typeof vb === 'number') return va - vb;
        if (va == null && vb == null) return 0;
        if (va == null) return -1;
        if (vb == null) return 1;
        return String(va).localeCompare(String(vb));
    }

    function draw() {
        const q = STATE.search.trim().toLowerCase();
        let rows = countries.filter(c => !q || c.name.toLowerCase().includes(q));
        rows.sort((a, b) => cmp(a, b, STATE.sortKey));
        if (STATE.sortDir === 'desc') rows.reverse();

        container.querySelectorAll('th.sortable').forEach(th => {
            th.classList.toggle('sorted', th.dataset.key === STATE.sortKey);
            th.dataset.sortDir = th.dataset.key === STATE.sortKey ? STATE.sortDir : '';
        });

        const body = container.querySelector('#table-body');
        body.innerHTML = rows.map(c => `
            <tr data-slug="${escapeAttr(c.slug)}">
                <td class="country-cell"><span class="country-name">${escapeHtml(c.name)}</span></td>
                ${visibleCategorical.map(k => `<td>${escapeHtml(c.categorical?.[k] || '')}</td>`).join('')}
                ${visibleMetricDefs.map(d => `<td class="numeric">${escapeHtml(formatValue(c.metrics?.[d.key], d))}</td>`).join('')}
            </tr>
        `).join('');

        body.querySelectorAll('tr[data-slug]').forEach(tr => {
            tr.addEventListener('click', () => {
                const slug = tr.dataset.slug;
                const country = countries.find(c => c.slug === slug);
                if (country && onSelect) onSelect(country);
            });
        });
    }

    draw();
    return { draw };
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
