/**
 * world-map.js - the interactive Andah map.
 *
 * One set of vector geometry drives both views. Rather than swapping between a
 * globe and a flat map, the two raw projections are blended: at alpha 0 the
 * orthographic wins and you get a planet, at alpha 1 the flat projection wins,
 * and animating alpha unrolls one into the other. The clipping angle opens from
 * 90 to 180 degrees as it goes, so the far side of the world comes into view as
 * the sphere flattens instead of appearing all at once at the end.
 *
 * Hit testing is geometric rather than by drawing to a hidden canvas: the cursor
 * is unprojected back to a longitude and latitude and tested against the
 * polygons, filtered first by bounding box. That stays exact at any zoom and
 * costs nothing per frame.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const cvs = $('map'), ctx = cvs.getContext('2d');
  const tip = $('tip');
  const PAD = 14;
  const MORPH_MS = 900;

  const CONTINENT_HUE = {
    Ayuma: 205, Atirha: 145, Acrola: 35, Mahea: 285, Massir: 5, Quia: 250, 'New Ayre': 90,
  };
  const RAMP = ['#e8f1fb', '#c3dcf1', '#96c3e4', '#6aa8d6', '#4189c4', '#2668aa', '#134a83'];

  let geo = null, data = null, cities = [], features = [], byName = new Map(), bounds = new Map();

  const state = {
    alpha: 0, rotation: [-40, -12], zoom: 1, panX: 0, panY: 0,
    flat: 'equirectangular', metric: '', selected: null, pinned: [],
    showCities: false, spinning: true,
  };

  // ------------------------------------------------------------- projection

  const FLAT_RAW = {};
  function rawFor(key) {
    if (FLAT_RAW[key]) return FLAT_RAW[key];
    const map = {
      equirectangular: d3.geoEquirectangularRaw,
      naturalEarth: d3.geoNaturalEarth1Raw,
      robinson: d3.geoRobinsonRaw,
      mollweide: d3.geoMollweideRaw,
      winkel3: d3.geoWinkel3Raw,
    };
    FLAT_RAW[key] = map[key] || d3.geoEquirectangularRaw;
    return FLAT_RAW[key];
  }

  function mixRaw(lambda, phi) {
    const a = d3.geoOrthographicRaw(lambda, phi);
    if (state.alpha === 0) return a;
    const b = rawFor(state.flat)(lambda, phi);
    return [a[0] + (b[0] - a[0]) * state.alpha, a[1] + (b[1] - a[1]) * state.alpha];
  }
  // Only ever asked for at rest, when alpha sits at one end or the other.
  mixRaw.invert = function (x, y) {
    const raw = state.alpha < 0.5 ? d3.geoOrthographicRaw : rawFor(state.flat);
    return raw.invert ? raw.invert(x, y) : null;
  };

  const projection = d3.geoProjection(mixRaw);
  const path = d3.geoPath(projection, ctx);
  const SPHERE = { type: 'Sphere' };
  const graticule = d3.geoGraticule10 ? d3.geoGraticule10() : d3.geoGraticule()();

  function frame() {
    const w = cvs.width, h = cvs.height;
    projection
      .rotate(state.rotation)
      .clipAngle(state.alpha >= 0.999 ? null : 90 + state.alpha * 89.9)
      .scale(1).translate([0, 0]);
    const b = path.bounds(SPHERE);
    const bw = Math.max(1e-6, b[1][0] - b[0][0]), bh = Math.max(1e-6, b[1][1] - b[0][1]);
    const s = Math.min((w - PAD * 2) / bw, (h - PAD * 2) / bh) * state.zoom;
    const cx = (b[0][0] + b[1][0]) / 2, cy = (b[0][1] + b[1][1]) / 2;
    projection.scale(s).translate([w / 2 - cx * s + state.panX, h / 2 - cy * s + state.panY]);
  }

  // ---------------------------------------------------------------- colours

  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  let bins = null;

  function buildBins() {
    bins = null;
    if (!state.metric) return;
    const vals = features
      .map((f) => valueOf(f.properties.name, state.metric))
      .filter((v) => typeof v === 'number' && Number.isFinite(v))
      .sort((a, b) => a - b);
    if (vals.length < RAMP.length) return;
    const cuts = [];
    for (let i = 1; i < RAMP.length; i++) cuts.push(vals[Math.floor((i * vals.length) / RAMP.length)]);
    bins = { cuts, min: vals[0], max: vals[vals.length - 1] };
  }
  const valueOf = (name, key) => {
    const c = data.countries[name];
    return c && c.metrics ? c.metrics[key] : undefined;
  };
  function colourOf(f) {
    const name = f.properties.name;
    if (state.metric) {
      const v = valueOf(name, state.metric);
      if (typeof v !== 'number' || !bins) return css('--line');
      let i = 0;
      while (i < bins.cuts.length && v >= bins.cuts[i]) i++;
      return RAMP[i];
    }
    const c = data.countries[name];
    const hue = (CONTINENT_HUE[c && c.continent] ?? 210);
    const dark = document.documentElement.dataset.theme !== 'light';
    let h = 0; for (let k = 0; k < name.length; k++) h = (h * 31 + name.charCodeAt(k)) >>> 0;
    return `hsl(${hue + (h % 34) - 17} ${dark ? 42 : 48}% ${dark ? 40 + (h % 16) : 62 + (h % 16)}%)`;
  }

  // ----------------------------------------------------------------- render

  function render() {
    const w = cvs.width, h = cvs.height;
    frame();
    ctx.clearRect(0, 0, w, h);

    ctx.beginPath(); path(SPHERE);
    ctx.fillStyle = css('--ocean'); ctx.fill();

    ctx.beginPath(); path(graticule);
    ctx.strokeStyle = css('--graticule'); ctx.lineWidth = 0.6; ctx.stroke();

    const stroke = css('--border');
    ctx.lineWidth = state.zoom > 3 ? 0.8 : 0.5;
    ctx.strokeStyle = stroke;
    for (const f of features) {
      ctx.beginPath(); path(f);
      ctx.fillStyle = colourOf(f);
      ctx.fill();
      ctx.stroke();
    }

    for (const name of state.pinned) {
      const f = byName.get(name);
      if (!f) continue;
      ctx.beginPath(); path(f);
      ctx.strokeStyle = css('--dim'); ctx.lineWidth = 1.6; ctx.stroke();
    }
    if (state.selected && byName.has(state.selected)) {
      ctx.beginPath(); path(byName.get(state.selected));
      ctx.strokeStyle = css('--accent'); ctx.lineWidth = 2.2; ctx.stroke();
    }

    if (state.showCities && cities.length) {
      ctx.fillStyle = css('--ink');
      for (const c of cities) {
        if (state.alpha < 0.5 && d3.geoDistance(c.ll, centre()) > Math.PI / 2) continue;
        const p = projection(c.ll);
        if (!p) continue;
        const r = Math.max(0.7, Math.min(4, Math.sqrt(c.population / 1e6) * 0.9) * Math.min(2, state.zoom));
        ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 6.283); ctx.fill();
      }
    }
  }

  const centre = () => [-state.rotation[0], -state.rotation[1]];

  let raf = null, needed = false;
  function draw() { if (!needed) { needed = true; requestAnimationFrame(() => { needed = false; render(); }); } }

  function loop() {
    if (state.spinning && state.alpha === 0) {
      state.rotation[0] += 0.09;
      render();
      raf = requestAnimationFrame(loop);
    } else raf = null;
  }
  function startSpin() { if (!raf && state.spinning) raf = requestAnimationFrame(loop); }
  function stopSpin() { state.spinning = false; }

  // --------------------------------------------------------------- morphing

  let morph = null;
  function morphTo(target, onDone) {
    stopSpin();
    const from = state.alpha, t0 = performance.now();
    // A flat map tilted off the equator is skewed and hard to read, so level it
    // on the way out. Longitude is left alone, which keeps whatever you were
    // looking at in the middle of the map.
    const tiltFrom = state.rotation[1], tiltTo = target >= 1 ? 0 : tiltFrom;
    if (morph) cancelAnimationFrame(morph);
    (function step(now) {
      const k = Math.min(1, (now - t0) / MORPH_MS);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;   // ease in and out
      state.alpha = from + (target - from) * e;
      state.rotation[1] = tiltFrom + (tiltTo - tiltFrom) * e;
      render();
      if (k < 1) morph = requestAnimationFrame(step);
      else { morph = null; state.alpha = target; state.rotation[1] = tiltTo; render(); if (onDone) onDone(); }
    })(t0);
  }

  // ------------------------------------------------------------- hit testing

  function countryAt(px, py) {
    if (morph) return null;
    let ll;
    try { ll = projection.invert([px, py]); } catch (e) { return null; }
    if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) return null;
    if (state.alpha < 0.5 && d3.geoDistance(ll, centre()) > Math.PI / 2) return null;
    for (const f of features) {
      const b = bounds.get(f.properties.name);
      if (ll[0] < b[0][0] - 0.5 || ll[0] > b[1][0] + 0.5 || ll[1] < b[0][1] - 0.5 || ll[1] > b[1][1] + 0.5) continue;
      if (d3.geoContains(f, ll)) return f;
    }
    return null;
  }

  // ------------------------------------------------------------ number format

  function fmt(v, kind) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    switch (kind) {
      case 'money':
        if (Math.abs(v) >= 1e12) return (v / 1e12).toFixed(2) + ' trillion';
        if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + ' billion';
        if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + ' million';
        return Math.round(v).toLocaleString();
      case 'money0': return Math.round(v).toLocaleString();
      case 'dec1': return v.toFixed(1);
      case 'dec2': return v.toFixed(2);
      case 'dec3': return v.toFixed(3);
      default: return Math.round(v).toLocaleString();
    }
  }
  const ordinal = (n) => {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  // ---------------------------------------------------------------- the panel

  function show(name) {
    state.selected = name;
    const card = $('card'), empty = $('empty');
    // Set both displays explicitly. Clearing the inline style instead would
    // simply hand control back to the stylesheet, where #card is display:none.
    if (!name || !data.countries[name]) {
      card.style.display = 'none'; empty.style.display = 'block'; draw(); syncUrl(); return;
    }
    const c = data.countries[name];
    empty.style.display = 'none'; card.style.display = 'block';

    const stat = (key, label, kind, unit) => {
      const v = c.metrics[key];
      if (typeof v !== 'number') return '';
      const rank = c.ranks && c.ranks[key];
      const share = rank ? (1 - (rank - 1) / data.countryCount) : 0;
      return `<div class="k">${label}${unit ? ` <span style="opacity:.65">${unit}</span>` : ''}</div>`
        + `<div class="v">${fmt(v, kind)}${rank ? `<small>${ordinal(rank)}</small>` : ''}</div>`
        + (rank ? `<div class="bar"><i style="width:${(share * 100).toFixed(1)}%"></i></div>` : '');
    };
    const row = (label, value) => (value ? `<dt>${label}</dt><dd>${value}</dd>` : '');
    const i = c.info || {};

    card.innerHTML = `
      <div class="head">
        <div class="top">
          ${c.flag ? `<img src="${c.flag}" alt="">` : ''}
          <div>
            <h2>${name}</h2>
            ${i.longName && i.longName !== name ? `<div class="long">${i.longName}</div>` : ''}
            ${c.pronunciation ? `<div class="say">${c.pronunciation}</div>` : ''}
          </div>
        </div>
        <div class="links">
          <a class="btn" href="${c.wiki}" target="_blank" rel="noopener">Wiki article</a>
          <button class="btn" id="pin">${state.pinned.includes(name) ? 'Unpin' : 'Compare'}</button>
        </div>
      </div>
      <div class="stats">
        ${stat('population', 'Population', 'int')}
        ${stat('areaKm2', 'Area', 'int', 'km²')}
        ${stat('gdpPPP', 'GDP (PPP)', 'money', 'lahn')}
        ${stat('ktdi', 'Development index', 'dec3')}
      </div>
      <details open>
        <summary>Identity</summary>
        <div class="body">
          ${row('Capital', c.capital)}${row('Largest city', i.largestCity)}
          ${row('Continent', c.continent)}${row('Region', c.geoscheme)}
          ${row('Demonym', c.demonym)}${row('Languages', i.officialLanguages)}
          ${row('Currency', i.currency)}${row('Domain', c.domain)}
          ${row('Calling code', i.callingCode)}${row('Drives on', i.drivesOn)}
          ${row('Time zone', i.timeZone)}
        </div>
      </details>
      <details>
        <summary>Economy and people</summary>
        <div class="stats">
          ${stat('density', 'Density', 'dec1', '/km²')}
          ${stat('gdpNominal', 'GDP (nominal)', 'money', 'lahn')}
          ${stat('gdpPPPPerCapita', 'GDP per head (PPP)', 'money0', 'lahn')}
          ${stat('gdpNomPerCapita', 'GDP per head (nominal)', 'money0', 'lahn')}
          ${stat('militaryNominal', 'Military spending', 'money', 'lahn')}
        </div>
        <div class="body">${row('Ethnic groups', i.ethnicGroups)}${row('Religion', i.religion)}</div>
      </details>
      <details>
        <summary>Government</summary>
        <div class="stats">${stat('gdi', 'Democratic integrity', 'dec2')}</div>
        <div class="body">
          ${row('Government', i.government)}${row('Legislature', i.legislature)}
          ${row(i.leaderTitle1 || 'Leader', i.leaderName1)}${row(i.leaderTitle2 || '', i.leaderTitle2 ? i.leaderName2 : '')}
          ${row('Upper house', i.upperHouse)}${row('Lower house', i.lowerHouse)}
          ${row('Established', i.established)}
          ${(i.establishedEvents || []).map((e) => row(e.event || 'Event', e.date)).join('')}
        </div>
      </details>`;

    const pin = $('pin');
    if (pin) pin.onclick = () => {
      const at = state.pinned.indexOf(name);
      if (at >= 0) state.pinned.splice(at, 1);
      else { state.pinned.push(name); if (state.pinned.length > 3) state.pinned.shift(); }
      drawTray(); show(name);
    };
    drawTray(); draw(); syncUrl();
  }

  function drawTray() {
    const tray = $('tray');
    if (!state.pinned.length) { tray.style.display = 'none'; return; }
    tray.style.display = 'block';
    const keys = [['population', 'Population', 'int'], ['areaKm2', 'Area km²', 'int'],
      ['gdpPPP', 'GDP PPP', 'money'], ['ktdi', 'KTDI', 'dec3']];
    tray.innerHTML = `<h3>Comparing</h3><table><thead><tr><th></th>${keys.map((k) => `<th>${k[1]}</th>`).join('')}<th></th></tr></thead><tbody>`
      + state.pinned.map((n) => {
        const c = data.countries[n];
        return `<tr><td>${n}</td>${keys.map((k) => `<td>${fmt(c.metrics[k[0]], k[2])}</td>`).join('')}<td class="x" data-n="${n}">×</td></tr>`;
      }).join('') + '</tbody></table>';
    tray.querySelectorAll('.x').forEach((el) => {
      el.onclick = () => { state.pinned = state.pinned.filter((n) => n !== el.dataset.n); drawTray(); if (state.selected) show(state.selected); draw(); };
    });
  }

  function flyTo(name) {
    const f = byName.get(name);
    if (!f) return;
    stopSpin();
    const c = d3.geoCentroid(f);
    const from = state.rotation.slice(), to = [-c[0], -c[1]], t0 = performance.now();
    (function step(now) {
      const k = Math.min(1, (now - t0) / 700);
      const e = 1 - Math.pow(1 - k, 3);
      // Take the short way round rather than spinning the long way.
      let d = to[0] - from[0];
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      state.rotation = [from[0] + d * e, from[1] + (to[1] - from[1]) * e];
      render();
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  }

  // -------------------------------------------------------------- interaction

  function resize() {
    const r = cvs.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cvs.width = Math.round(r.width * dpr); cvs.height = Math.round(r.height * dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return true;
  }
  const toCanvas = (e) => {
    const r = cvs.getBoundingClientRect();
    const sx = cvs.width / r.width, sy = cvs.height / r.height;
    return [(e.clientX - r.left) * sx, (e.clientY - r.top) * sy];
  };

  let drag = null, dragged = false;
  cvs.addEventListener('mousedown', (e) => {
    drag = { x: e.clientX, y: e.clientY, rot: state.rotation.slice(), px: state.panX, py: state.panY, moved: false };
    cvs.classList.add('dragging');
    stopSpin();
  });
  // mouseup runs before click, so remember whether this gesture was a drag;
  // reading it off the (by then discarded) drag object never worked.
  window.addEventListener('mouseup', () => {
    dragged = !!(drag && drag.moved);
    drag = null;
    cvs.classList.remove('dragging');
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (state.alpha < 0.5) {
      const k = 0.26 / state.zoom;
      state.rotation = [drag.rot[0] + dx * k, Math.max(-90, Math.min(90, drag.rot[1] - dy * k))];
    } else {
      state.panX = drag.px + dx; state.panY = drag.py + dy;
    }
    tip.style.display = 'none';
    draw();
  });
  cvs.addEventListener('mousemove', (e) => {
    if (drag) return;
    const [x, y] = toCanvas(e);
    const f = countryAt(x, y);
    if (!f) { tip.style.display = 'none'; return; }
    const c = data.countries[f.properties.name];
    tip.innerHTML = `<b>${f.properties.name}</b>`
      + (c && typeof c.metrics.population === 'number' ? ` · ${fmt(c.metrics.population, 'int')}` : '')
      + (state.metric && typeof c.metrics[state.metric] === 'number'
        ? `<br>${metricLabel(state.metric)}: ${fmt(c.metrics[state.metric], metricKind(state.metric))}` : '');
    tip.style.display = 'block';
    const r = cvs.getBoundingClientRect();
    tip.style.left = Math.min(e.clientX - r.left + 14, r.width - tip.offsetWidth - 8) + 'px';
    tip.style.top = (e.clientY - r.top + 16) + 'px';
  });
  cvs.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  cvs.addEventListener('click', (e) => {
    if (dragged) { dragged = false; return; }
    const [x, y] = toCanvas(e);
    const f = countryAt(x, y);
    show(f ? f.properties.name : null);
  });
  cvs.addEventListener('wheel', (e) => {
    e.preventDefault();
    stopSpin();
    state.zoom = Math.max(1, Math.min(40, state.zoom * Math.exp(-e.deltaY * 0.0012)));
    if (state.zoom === 1) { state.panX = 0; state.panY = 0; }
    draw();
  }, { passive: false });

  const metricLabel = (k) => (data.metrics.find((m) => m.key === k) || {}).label || k;
  const metricKind = (k) => (data.metrics.find((m) => m.key === k) || {}).kind || 'int';

  function drawLegend() {
    const el = $('legend');
    if (!state.metric || !bins) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    const spec = data.metrics.find((m) => m.key === state.metric);
    const edges = [bins.min, ...bins.cuts, bins.max];
    el.innerHTML = `<div class="t">${spec.label}${spec.unit ? ` (${spec.unit})` : ''}</div>`
      + RAMP.map((c, k) => `<div class="row"><i style="background:${c}"></i>`
        + `${fmt(edges[k], spec.kind)} – ${fmt(edges[k + 1], spec.kind)}</div>`).reverse().join('');
  }

  // --------------------------------------------------------------- deep links

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.selected) p.set('c', data.countries[state.selected].slug);
    p.set('v', state.alpha >= 0.5 ? 'flat' : 'globe');
    if (state.metric) p.set('m', state.metric);
    if (state.flat !== 'equirectangular') p.set('p', state.flat);
    history.replaceState(null, '', '?' + p.toString());
  }

  // -------------------------------------------------------------------- setup

  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('andah-map-theme', t); } catch (e) {}
    draw(); drawLegend();
  }

  Promise.all([
    fetch('data/andah-countries.geojson').then((r) => r.json()),
    fetch('data/andah-map-data.json').then((r) => r.json()),
    fetch('data/flight-cities.json').then((r) => r.json()).catch(() => null),
  ]).then(([g, d, city]) => {
    geo = g; data = d;
    features = geo.features;

    // The GeoJSON spec winds exterior rings counterclockwise, but d3 reads a
    // ring as the region on its left in spherical terms, which is the opposite
    // way round: fed spec-compliant data it decides each country is everything
    // except itself and paints the entire globe. Detect rather than assume, so
    // this stays correct whichever convention the file happens to use.
    let flipped = 0;
    for (const f of features) {
      if (d3.geoArea(f) > 2 * Math.PI) {
        for (const poly of f.geometry.coordinates) for (const ring of poly) ring.reverse();
        flipped++;
      }
    }
    if (flipped) console.info(`world-map: reversed winding on ${flipped} of ${features.length} features for d3`);

    for (const f of features) { byName.set(f.properties.name, f); bounds.set(f.properties.name, d3.geoBounds(f)); }
    if (city && city.map) {
      cities = city.cities.map((c) => ({
        population: c.population || 0,
        ll: [(c.x / city.map.width) * 360 - 180, 90 - (c.y / city.map.height) * 180],
      })).sort((a, b) => b.population - a.population);
    }

    $('countrylist').innerHTML = features.map((f) => `<option value="${f.properties.name}">`).join('');
    $('metric').innerHTML = '<option value="">Colour by continent</option>'
      + data.metrics.map((m) => `<option value="${m.key}">${m.label}</option>`).join('');

    // Restore whatever the URL and last visit asked for.
    try { setTheme(localStorage.getItem('andah-map-theme') || 'dark'); } catch (e) { setTheme('dark'); }
    const q = new URLSearchParams(location.search);
    if (q.get('p')) { state.flat = q.get('p'); $('proj').value = state.flat; }
    if (q.get('m')) { state.metric = q.get('m'); $('metric').value = state.metric; buildBins(); drawLegend(); }
    if (q.get('v') === 'flat') {
      state.alpha = 1; state.rotation[1] = 0; state.spinning = false;
      $('toGlobe').classList.remove('on'); $('toFlat').classList.add('on');
    }
    const want = q.get('c') && features.find((f) => f.id === q.get('c'));

    // Sizing is deliberately belt and braces. The canvas can be measured before
    // the page has been laid out, in which case it reports zero and there is
    // nothing sensible to draw into; retry until it reports a real size.
    let sized = resize();
    render();
    if (!sized) {
      let tries = 0;
      const again = () => {
        if (resize()) { sized = true; render(); return; }
        if (++tries < 60) requestAnimationFrame(again);
      };
      requestAnimationFrame(again);
    }
    window.addEventListener('resize', () => { if (resize()) render(); });
    if (window.ResizeObserver) new ResizeObserver(() => { if (resize()) render(); }).observe($('stage'));

    if (want) { show(want.properties.name); flyTo(want.properties.name); }
    else if (state.alpha === 0) startSpin();
  }).catch((err) => {
    $('empty').innerHTML = `<b>Could not load the map data.</b><br><br>${err}`
      + '<br><br>This page reads its data with fetch, so it needs to be served over http rather than opened straight off disk.';
  });

  $('toGlobe').onclick = () => {
    $('toGlobe').classList.add('on'); $('toFlat').classList.remove('on');
    state.panX = 0; state.panY = 0;
    morphTo(0, syncUrl);
  };
  $('toFlat').onclick = () => {
    $('toFlat').classList.add('on'); $('toGlobe').classList.remove('on');
    morphTo(1, syncUrl);
  };
  $('proj').onchange = (e) => { state.flat = e.target.value; draw(); syncUrl(); };
  $('metric').onchange = (e) => { state.metric = e.target.value; buildBins(); drawLegend(); draw(); syncUrl(); };
  $('cities').onclick = () => { state.showCities = !state.showCities; $('cities').classList.toggle('on', state.showCities); draw(); };
  $('theme').onclick = () => setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  $('search').onchange = (e) => {
    const name = e.target.value.trim();
    if (byName.has(name)) { show(name); flyTo(name); e.target.blur(); }
  };
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') show(null); });
})();
