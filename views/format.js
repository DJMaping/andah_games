// Number formatters keyed by metricDef.format ("integer" | "currency" | "percent" | "number").

const compactUnits = [
    { amount: 1e12, suffix: 'T' },
    { amount: 1e9, suffix: 'B' },
    { amount: 1e6, suffix: 'M' },
    { amount: 1e3, suffix: 'k' }
];

export function compact(value) {
    if (!Number.isFinite(value)) return '–';
    const abs = Math.abs(value);
    const unit = compactUnits.find(u => abs >= u.amount);
    if (!unit) return value.toLocaleString();
    const c = value / unit.amount;
    const digits = Math.abs(c) >= 100 ? 0 : Math.abs(c) >= 10 ? 1 : 2;
    return `${c.toFixed(digits).replace(/\.0+$/, '')}${unit.suffix}`;
}

export function formatValue(value, def) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '–';
    const format = def?.format || 'number';
    switch (format) {
        case 'integer':
            return Math.round(value).toLocaleString();
        case 'currency':
            return compact(value);
        case 'percent':
            return `${(value * 100).toFixed(1)}%`;
        default:
            return value.toLocaleString();
    }
}

export function formatValueLong(value, def) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '–';
    const format = def?.format || 'number';
    if (format === 'percent') return `${(value * 100).toFixed(2)}%`;
    return Math.round(value).toLocaleString();
}
