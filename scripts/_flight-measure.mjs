import { readFileSync } from 'node:fs';
import { generateNetwork } from '../views/flight-routes.js';
import { FLIGHT_CONFIG } from '../views/flight-config.js';

const cityDoc = JSON.parse(readFileSync('data/flight-cities.json', 'utf8'));
const countries = JSON.parse(readFileSync('data/countries.json', 'utf8')).countries || [];

function gpcOf(metrics) {
    if (!metrics) return NaN;
    for (const k of ['gdpPerNominal', 'Per (NOM)', 'GDP Capita', 'gdpCapita']) {
        const v = metrics[k];
        if (Number.isFinite(v) && v > 0) return v;
    }
    return NaN;
}
const gpcByNation = new Map();
let sum = 0, n = 0;
for (const c of countries) {
    const g = gpcOf(c.metrics);
    if (Number.isFinite(g) && g > 0) { gpcByNation.set(c.name, g); sum += g; n++; }
}
const avg = n ? sum / n : 1;
const map = cityDoc.map || { width: 10000, height: 4999 };
function p2ll(x, y) { return { lon: (x / map.width) * 360 - 180, lat: 90 - (y / map.height) * 180 }; }
const slug = s => String(s).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');

const airports = [];
for (const city of cityDoc.cities) {
    const population = Number.isFinite(city.population) ? city.population : 0;
    if (population <= 0 || !Number.isFinite(city.x) || !Number.isFinite(city.y)) continue;
    const gpc = gpcByNation.get(city.nation) || avg;
    const mass = population * gpc;
    const { lat, lon } = p2ll(city.x, city.y);
    airports.push({
        id: city.id || slug(city.airport || city.city),
        city: city.airport && city.airport !== city.city ? city.airport : city.city,
        displayCity: city.city, country: city.nation, x: city.x, y: city.y, lat, lon,
        band: city.band || null, mass,
        metrics: { population, gdpPerCapita: gpc, gdpNominal: mass }
    });
}

const net = generateNetwork(airports, FLIGHT_CONFIG);
const { routes } = net;
const deg = new Map();
for (const a of net.airports) deg.set(a.id, a.degree);
const degs = [...deg.values()].sort((a, b) => a - b);
const q = p => degs[Math.floor((degs.length - 1) * p)];
const dom = routes.filter(r => r.domestic).length;

console.log('routes', routes.length, '| domestic', (100 * dom / routes.length).toFixed(1) + '%');
console.log('degree min/median/p90/max', degs[0], q(0.5), q(0.9), degs[degs.length - 1]);
console.log('demand range', Math.min(...routes.map(r => r.demand)).toFixed(4), Math.max(...routes.map(r => r.demand)).toFixed(4));
const stroke = r => FLIGHT_CONFIG.arcStrokeMin + (FLIGHT_CONFIG.arcStrokeMax - FLIGHT_CONFIG.arcStrokeMin) * (r.demand || 0);
const ws = routes.map(stroke).sort((a, b) => a - b);
console.log('stroke min/median/max', ws[0].toFixed(2), ws[Math.floor(ws.length / 2)].toFixed(2), ws[ws.length - 1].toFixed(2),
    '| >0.8 share', (100 * ws.filter(w => w > 0.8).length / ws.length).toFixed(1) + '%');

// per-nation route counts
const byNation = new Map();
const popByNation = new Map();
for (const a of airports) popByNation.set(a.country, (popByNation.get(a.country) || 0) + a.metrics.population);
for (const r of routes) {
    const fc = airports.find(a => a.id === r.from)?.country;
    const tc = airports.find(a => a.id === r.to)?.country;
    if (fc) byNation.set(fc, (byNation.get(fc) || 0) + 1);
    if (tc && tc !== fc) byNation.set(tc, (byNation.get(tc) || 0) + 1);
}
function show(name) {
    const cities = airports.filter(a => a.country === name);
    if (!cities.length) { console.log('  [not found]', name); return; }
    console.log(`  ${name}: ${byNation.get(name) || 0} routes | ${cities.length} cities | pop ${(popByNation.get(name) / 1e6).toFixed(1)}M | gpc ${Math.round(gpcByNation.get(name) || avg)}`);
}
console.log('SPOTLIGHT:');
['Ztesh', 'Inania', 'Dahe', 'Raledria'].forEach(show);
console.log('TOP 12 CITIES BY DEGREE:');
[...net.airports].sort((a, b) => b.degree - a.degree).slice(0, 12).forEach(a =>
    console.log(`  ${a.city} (${a.country})${a.isHub ? ' [HUB]' : ''}: deg ${a.degree} | pop ${(a.metrics.population / 1e6).toFixed(1)}M`));
// biggest by population
console.log('TOP 8 BY POPULATION:');
[...popByNation.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([nm]) => show(nm));
