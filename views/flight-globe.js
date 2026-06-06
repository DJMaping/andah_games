// Flight Network — 3D globe view (globe.gl, loaded from a CDN as an ES module).
//
// Renders maps/map.png as the globe texture, airports as points (size ∝
// population), and routes as animated great-circle arcs (colour by haul, stroke
// ∝ demand). Auto-rotates until the user interacts. Selecting a city dims every
// arc that doesn't touch it.
//
// createGlobe() is async because it dynamic-imports globe.gl — if the CDN is
// unreachable the caller can catch and fall back to the 2D map.

const GLOBE_CDN = 'https://esm.sh/globe.gl@2';

export async function createGlobe(container, { config, onSelect } = {}) {
    const { default: Globe } = await import(GLOBE_CDN);

    let airports = [];
    let routes = [];
    let selectedId = null;
    let incident = new Set();      // keys "from|to" of routes touching selectedId
    let popDomain = [1, 1];

    const world = Globe()(container)
        .globeImageUrl('maps/map.png')
        .backgroundColor('rgba(0,0,0,0)')
        .showAtmosphere(true)
        .atmosphereColor('#9ec4ff')
        .atmosphereAltitude(0.18)
        .pointLat('lat')
        .pointLng('lon')
        .pointAltitude(0.012)
        .pointRadius(pointRadius)
        .pointColor(pointColor)
        .pointLabel(d => `<b>${esc(d.city)}</b><br>${esc(d.country)}`)
        .onPointClick(d => onSelect && onSelect(d.id))
        .arcStartLat('fromLat').arcStartLng('fromLon')
        .arcEndLat('toLat').arcEndLng('toLon')
        .arcColor(arcColor)
        .arcStroke(arcStroke)
        .arcAltitude(0)              // flat against the globe surface
        .arcDashLength(1)            // solid...
        .arcDashGap(0)
        .arcDashAnimateTime(0)       // ...and static (no animation)
        .arcsTransitionDuration(0);

    // Auto-rotate until first interaction.
    const controls = world.controls();
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.5;
    const stopSpin = () => { controls.autoRotate = false; };
    container.addEventListener('pointerdown', stopSpin, { once: true });

    function key(r) { return r.from < r.to ? r.from + '|' + r.to : r.to + '|' + r.from; }

    function pointRadius(d) {
        const [lo, hi] = popDomain;
        const v = (d.metrics && d.metrics.population) || 0;
        const t = hi > lo ? (Math.sqrt(Math.max(v, 1)) - Math.sqrt(lo)) / (Math.sqrt(hi) - Math.sqrt(lo)) : 0.5;
        return config.pointMinRadius + (config.pointMaxRadius - config.pointMinRadius) * Math.max(0, Math.min(1, t));
    }
    function pointColor(d) {
        if (d.id === selectedId) return config.selectedColor;
        return d.isHub ? config.hubColor : config.pointColor;
    }
    function arcColor(r) {
        if (selectedId && !incident.has(key(r))) {
            return `rgba(180,190,200,${config.dimOpacity})`;
        }
        return config.haulColors[r.haul] || config.haulColors.long;
    }
    function arcStroke(r) {
        const t = r.demand || 0;
        const base = config.arcStrokeMin + (config.arcStrokeMax - config.arcStrokeMin) * t;
        return selectedId && incident.has(key(r)) ? base * 1.8 : base;
    }

    function recomputeIncident() {
        incident = new Set();
        if (!selectedId) return;
        for (const r of routes) if (r.from === selectedId || r.to === selectedId) incident.add(key(r));
    }

    function refresh() {
        // Re-trigger accessors by re-setting the data arrays.
        world.pointsData(airports);
        world.arcsData(routes);
    }

    const ro = new ResizeObserver(() => {
        world.width(container.clientWidth || 600);
        world.height(container.clientHeight || 400);
    });
    ro.observe(container);
    world.width(container.clientWidth || 600);
    world.height(container.clientHeight || 400);

    return {
        setData(net) {
            airports = net.airports || [];
            if (net.map && net.map.image) world.globeImageUrl(net.map.image);
            const pops = airports.map(a => (a.metrics && a.metrics.population) || 0).filter(v => v > 0);
            popDomain = pops.length ? [Math.min(...pops), Math.max(...pops)] : [1, 1];
            world.pointsData(airports);
        },
        // visibleRoutes already filtered; selectedId may be null.
        update({ visibleRoutes, selectedId: sel }) {
            routes = visibleRoutes || [];
            selectedId = sel || null;
            recomputeIncident();
            refresh();
        },
        focus(id) {
            const a = airports.find(x => x.id === id);
            if (a) world.pointOfView({ lat: a.lat, lng: a.lon, altitude: 1.7 }, 800);
        },
        resize() {
            world.width(container.clientWidth || 600);
            world.height(container.clientHeight || 400);
        },
        destroy() {
            ro.disconnect();
            container.removeEventListener('pointerdown', stopSpin);
            if (world._destructor) world._destructor();
            container.innerHTML = '';
        }
    };
}

function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
