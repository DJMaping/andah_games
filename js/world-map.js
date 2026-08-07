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

  // Each continent gets a hue; countries within it vary by +/-17 degrees so
  // neighbours stay apart. The bands are spaced to leave no overlap once that
  // jitter is applied.
  const CONTINENT_HUE = {
    Ayuma: 2,          // red
    Atirha: 214,       // blue
    Acrola: 40,        // orange
    Mahea: 320,        // pink
    Massir: 138,       // green
    Quia: 278,         // purple
    'New Ayre': 176,   // turquoise
  };
  const RAMP = ['#e8f1fb', '#c3dcf1', '#96c3e4', '#6aa8d6', '#4189c4', '#2668aa', '#134a83'];

  let geo = null, data = null, cities = [], features = [], byName = new Map(), bounds = new Map();
  // Largest first, so the countries that matter most claim their space before
  // the small ones try to fit into what is left.
  let labelOrder = [];
  // A coarser copy of the same geometry, used only while the map is moving.
  // Projecting 142,000 points every frame costs ~50 ms; this one costs a third
  // of that, and the difference is invisible on something that is turning.
  let featuresLow = null;

  const state = {
    alpha: 0, rotation: [-40, -12], zoom: 1, panX: 0, panY: 0,
    flat: 'equirectangular', metric: '', selected: null, pinned: [],
    showCities: false, showLabels: true, spinning: true,
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
    // Heiso is listed as "Ayuma/Acrola". Take the first named continent rather
    // than falling through to a default that would collide with Atirha's blue.
    const cont = (c && c.continent) ? c.continent.split('/')[0].trim() : '';
    const hue = (CONTINENT_HUE[cont] ?? 40);
    const dark = document.documentElement.dataset.theme !== 'light';
    let h = 0; for (let k = 0; k < name.length; k++) h = (h * 31 + name.charCodeAt(k)) >>> 0;
    return `hsl(${hue + (h % 34) - 17} ${dark ? 42 : 48}% ${dark ? 40 + (h % 16) : 62 + (h % 16)}%)`;
  }

  // ----------------------------------------------------------------- render

  // Moving: anything that will be redrawn again immediately.
  const inMotion = () => !!(morph || drag || touch || (state.spinning && state.alpha === 0));

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
    const drawSet = (inMotion() && featuresLow) ? featuresLow : features;
    for (const f of drawSet) {
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

    // Labels are skipped while moving: they cannot be read anyway, and placing
    // them costs a full pass of collision tests.
    if (state.showLabels && !inMotion()) drawLabels();

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

  /**
   * Country names, largest country first, dropped whenever they will not fit.
   *
   * A label is only drawn if it fits inside the country's own projected extent
   * and does not collide with one already placed, so zooming in reveals more
   * names rather than the map showing a hundred overlapping words at once.
   */
  function drawLabels() {
    const placed = [];
    const dark = document.documentElement.dataset.theme !== 'light';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const onGlobe = state.alpha < 0.5;
    const eye = centre();

    for (const f of labelOrder) {
      const anchor = f.properties.label;
      if (!anchor) continue;
      if (onGlobe && d3.geoDistance(anchor, eye) > Math.PI / 2) continue;
      const p = projection(anchor);
      if (!p || !Number.isFinite(p[0])) continue;
      if (p[0] < -40 || p[1] < -20 || p[0] > cvs.width + 40 || p[1] > cvs.height + 20) continue;

      // How big is this country on screen? Projecting the corners of its
      // longitude/latitude bounds is four operations, against streaming the
      // whole outline again for an exact box.
      const b = bounds.get(f.properties.name);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const c of [[b[0][0], b[0][1]], [b[1][0], b[0][1]], [b[0][0], b[1][1]], [b[1][0], b[1][1]]]) {
        const q = projection(c);
        if (!q || !Number.isFinite(q[0])) continue;
        if (q[0] < minX) minX = q[0]; if (q[0] > maxX) maxX = q[0];
        if (q[1] < minY) minY = q[1]; if (q[1] > maxY) maxY = q[1];
      }
      const boxW = maxX - minX, boxH = maxY - minY;
      if (!Number.isFinite(boxW) || boxH < 11) continue;

      const size = Math.max(10, Math.min(15, 9 + Math.sqrt(boxW) * 0.28));
      ctx.font = `500 ${size.toFixed(1)}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`;
      const text = f.properties.name;
      const tw = ctx.measureText(text).width;
      if (tw > boxW * 0.92) continue;                       // no room inside the country

      const rect = [p[0] - tw / 2 - 3, p[1] - size * 0.7, tw + 6, size * 1.4];
      let clash = false;
      for (const r of placed) {
        if (rect[0] < r[0] + r[2] && rect[0] + rect[2] > r[0] && rect[1] < r[1] + r[3] && rect[1] + rect[3] > r[1]) { clash = true; break; }
      }
      if (clash) continue;
      placed.push(rect);

      ctx.lineWidth = 3;
      ctx.strokeStyle = dark ? 'rgba(6,12,20,.85)' : 'rgba(255,255,255,.9)';
      ctx.strokeText(text, p[0], p[1]);
      ctx.fillStyle = dark ? '#eef5fb' : '#16222e';
      ctx.fillText(text, p[0], p[1]);
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
    lastLabelCount = placed.length;
  }
  let lastLabelCount = 0;

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
    // Unrolling to a flat map, settle on the natural frame: no tilt, and
    // centred on the prime meridian. A tilted flat map is skewed and hard to
    // read, and leaving the longitude wherever the globe happened to be
    // spun to slices continents in half at both edges. Andah has no land at
    // the antimeridian, so centred on zero nothing is ever cut.
    const flattening = target >= 1;
    const spinFrom = state.rotation[0], tiltFrom = state.rotation[1];
    let spinDelta = flattening ? -spinFrom : 0;
    while (spinDelta > 180) spinDelta -= 360;
    while (spinDelta < -180) spinDelta += 360;
    const tiltTo = flattening ? 0 : tiltFrom;
    const panFromX = state.panX, panFromY = state.panY;
    if (morph) cancelAnimationFrame(morph);
    (function step(now) {
      const k = Math.min(1, (now - t0) / MORPH_MS);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;   // ease in and out
      state.alpha = from + (target - from) * e;
      state.rotation = [spinFrom + spinDelta * e, tiltFrom + (tiltTo - tiltFrom) * e];
      if (flattening) { state.panX = panFromX * (1 - e); state.panY = panFromY * (1 - e); }
      render();
      if (k < 1) morph = requestAnimationFrame(step);
      else {
        morph = null;
        state.alpha = target;
        state.rotation = [spinFrom + spinDelta, tiltTo];
        if (flattening) { state.panX = 0; state.panY = 0; }
        render();
        if (onDone) onDone();
      }
    })(t0);
  }

  // ------------------------------------------------------------- hit testing

  function countryAt(px, py) {
    if (morph) return null;
    // Bring the projection up to date first. It is otherwise only recomputed
    // while drawing, so a click landing between a gesture and the next frame
    // would be unprojected through the previous view and hit the wrong country.
    frame();
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
    // Announce the selection, so the map is followable without seeing it.
    const say = $('say');
    if (say) {
      say.textContent = `${name}. Capital ${c.capital || 'unknown'}. `
        + (typeof c.metrics.population === 'number'
          ? `Population ${Math.round(c.metrics.population).toLocaleString()}, ${ordinal(c.ranks.population)} of ${data.countryCount}.` : '');
    }

    const i = c.info || {};
    const feature = byName.get(name);
    const nb = (feature && feature.properties.neighbours) || [];
    const N = data.countryCount;

    // A headline figure: value on its own line, rank underneath. Appending the
    // rank to the number ran them together into "81,313,72919th".
    const key = (k, label, kind, unit) => {
      const v = c.metrics[k];
      if (typeof v !== 'number') return '';
      const rank = c.ranks && c.ranks[k];
      const share = rank ? (1 - (rank - 1) / N) : 0;
      return `<div class="key">
        <div class="lab">${label}</div>
        <div class="num">${fmt(v, kind)}${unit ? `<u>${unit}</u>` : ''}</div>
        ${rank ? `<div class="rank">${ordinal(rank)} of ${N}</div>
        <div class="bar"><i style="width:${(share * 100).toFixed(1)}%"></i></div>` : ''}
      </div>`;
    };
    const stat = (k, label, kind, unit) => {
      const v = c.metrics[k];
      if (typeof v !== 'number') return '';
      const rank = c.ranks && c.ranks[k];
      return `<div class="fact inline"><dt>${label}${unit ? ` ${unit}` : ''}</dt>`
        + `<dd>${fmt(v, kind)}${rank ? `<span class="rk">${ordinal(rank)}</span>` : ''}</dd></div>`;
    };
    const fact = (label, value) => (value ? `<div class="fact"><dt>${label}</dt><dd>${value}</dd></div>` : '');
    const inline = (label, value) => (value ? `<div class="fact inline"><dt>${label}</dt><dd>${value}</dd></div>` : '');
    const split = (list) => (!list || !list.length ? '' : `<div class="split">`
      + list.map((r) => `<div class="s">
          <div class="t"><b>${r.label}</b><span>${r.pct !== null ? r.pct + '%' : ''}</span></div>
          ${r.pct !== null ? `<div class="g"><i style="width:${Math.min(100, r.pct).toFixed(1)}%"></i></div>` : ''}
        </div>`
        + (r.children || []).map((s) => `<div class="s sub">
            <div class="t"><b>${s.label}</b><span>${s.pct !== null ? s.pct + '%' : ''}</span></div>
            ${s.pct !== null ? `<div class="g"><i style="width:${Math.min(100, s.pct).toFixed(1)}%"></i></div>` : ''}
          </div>`).join('')).join('')
      + `</div>`);

    card.innerHTML = `
      <div class="head">
        <div class="top">
          ${c.flag ? `<img src="${c.flag}" alt="Flag of ${name}">` : ''}
          <div class="who">
            <h2>${name}</h2>
            ${i.longName && i.longName !== name ? `<div class="long">${i.longName}</div>` : ''}
            ${c.pronunciation ? `<div class="say">${c.pronunciation}</div>` : ''}
            ${c.continent ? `<div class="where"><b>${c.continent}</b>${c.geoscheme ? ` · ${c.geoscheme}` : ''}</div>` : ''}
          </div>
        </div>
        <div class="links">
          <a class="btn" href="${c.wiki}" target="_blank" rel="noopener">Wiki article ↗</a>
          <button class="btn" id="pin">${state.pinned.includes(name) ? 'Remove from compare' : 'Compare'}</button>
        </div>
      </div>

      <div class="keys">
        ${key('population', 'Population', 'int')}
        ${key('areaKm2', 'Area', 'int', 'km²')}
        ${key('gdpPPP', 'GDP (PPP)', 'money', 'lahn')}
        ${key('ktdi', 'Development', 'dec3')}
      </div>

      <details open>
        <summary>Identity</summary>
        <div class="body">
          ${inline('Capital', c.capital)}
          ${i.largestCity && i.largestCity !== c.capital ? inline('Largest city', i.largestCity) : ''}
          ${inline('Demonym', c.demonym)}
          ${fact('Official languages', i.officialLanguages)}
          ${i.regionalLanguages ? fact('Regional languages', i.regionalLanguages) : ''}
          ${fact('Currency', i.currency)}
          ${inline('Internet domain', c.domain || i.cctld)}
          ${inline('Calling code', i.callingCode)}
          ${inline('Drives on', i.drivesOn)}
          ${fact('Time zone', i.timeZone)}
        </div>
      </details>

      ${nb.length ? `<details>
        <summary>Borders (${nb.length})</summary>
        <div class="chips">
          ${nb.map((n) => `<button class="chip" data-go="${n.name}">${n.name}<span>${n.km.toLocaleString()} km</span></button>`).join('')}
        </div>
      </details>` : '<div class="lone">No land borders — an island nation.</div>'}

      <details>
        <summary>Economy</summary>
        <div class="body">
          ${stat('gdpNominal', 'GDP (nominal)', 'money', '· lahn')}
          ${stat('gdpPPPPerCapita', 'GDP per head (PPP)', 'money0', '· lahn')}
          ${stat('gdpNomPerCapita', 'GDP per head (nominal)', 'money0', '· lahn')}
          ${stat('militaryNominal', 'Military spending', 'money', '· lahn')}
        </div>
      </details>

      <details>
        <summary>People</summary>
        <div class="body">
          ${stat('density', 'Density', 'dec1', '· per km²')}
          ${i.ethnicBreakdown ? `<div class="fact"><dt>Ethnic groups</dt><dd>${split(i.ethnicBreakdown)}</dd></div>`
            : fact('Ethnic groups', i.ethnicGroups)}
          ${i.religionBreakdown ? `<div class="fact"><dt>Religion</dt><dd>${split(i.religionBreakdown)}</dd></div>`
            : fact('Religion', i.religion)}
        </div>
      </details>

      <details>
        <summary>Government</summary>
        <div class="body">
          ${fact('System', i.government)}
          ${stat('gdi', 'Democratic integrity', 'dec2')}
          ${fact('Legislature', i.legislature)}
          ${i.upperHouse ? inline('Upper house', i.upperHouse) : ''}
          ${i.lowerHouse ? inline('Lower house', i.lowerHouse) : ''}
          ${i.leaderName1 ? inline(i.leaderTitle1 || 'Leader', i.leaderName1) : ''}
          ${i.leaderName2 ? inline(i.leaderTitle2 || 'Deputy', i.leaderName2) : ''}
        </div>
      </details>

      ${(i.establishedEvents && i.establishedEvents.length) || i.established ? `<details>
        <summary>History</summary>
        <div class="body">
          ${i.established ? inline('Established', i.established) : ''}
          ${(i.establishedEvents || []).length ? `<div class="tl">
            ${i.establishedEvents.map((e) => `<div class="e"><time>${e.date || ''}</time><span>${e.event || ''}</span></div>`).join('')}
          </div>` : ''}
        </div>
      </details>` : ''}

      ${i.motto || i.anthem ? `<details>
        <summary>Symbols</summary>
        <div class="body">
          ${fact('Motto', i.motto)}
          ${fact('Anthem', i.anthem)}
        </div>
      </details>` : ''}`;

    card.querySelectorAll('[data-go]').forEach((el) => {
      el.onclick = () => { show(el.dataset.go); flyTo(el.dataset.go); };
    });
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
    zoomBy(Math.exp(-e.deltaY * 0.0012));
  }, { passive: false });

  function zoomBy(factor) {
    state.zoom = Math.max(1, Math.min(40, state.zoom * factor));
    if (state.zoom === 1) { state.panX = 0; state.panY = 0; }
    draw();
  }

  // ------------------------------------------------------------------ touch

  // Without these the map is simply unusable on a phone or tablet: a canvas
  // gets no drag, no zoom and no selection from touch events on its own.
  let touch = null;
  const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  cvs.addEventListener('touchstart', (e) => {
    stopSpin();
    const t = e.touches;
    touch = {
      moved: false,
      x: t[0].clientX, y: t[0].clientY,
      rot: state.rotation.slice(), px: state.panX, py: state.panY,
      pinch: t.length > 1 ? spread(t) : 0,
      zoom: state.zoom,
    };
  }, { passive: true });

  cvs.addEventListener('touchmove', (e) => {
    if (!touch) return;
    e.preventDefault();
    const t = e.touches;
    if (t.length > 1 && touch.pinch) {
      touch.moved = true;
      state.zoom = Math.max(1, Math.min(40, touch.zoom * (spread(t) / touch.pinch)));
      if (state.zoom === 1) { state.panX = 0; state.panY = 0; }
      draw();
      return;
    }
    const dx = t[0].clientX - touch.x, dy = t[0].clientY - touch.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) touch.moved = true;
    if (state.alpha < 0.5) {
      const k = 0.26 / state.zoom;
      state.rotation = [touch.rot[0] + dx * k, Math.max(-90, Math.min(90, touch.rot[1] - dy * k))];
    } else {
      state.panX = touch.px + dx; state.panY = touch.py + dy;
    }
    draw();
  }, { passive: false });

  cvs.addEventListener('touchend', (e) => {
    if (touch && !touch.moved && e.changedTouches.length) {
      const c = e.changedTouches[0];
      const b = cvs.getBoundingClientRect();
      const sx = cvs.width / b.width, sy = cvs.height / b.height;
      const f = countryAt((c.clientX - b.left) * sx, (c.clientY - b.top) * sy);
      show(f ? f.properties.name : null);
    }
    touch = null;
  }, { passive: true });

  // --------------------------------------------------------------- keyboard

  // A canvas is invisible to the keyboard by default, which leaves the whole
  // map unreachable without a pointing device.
  cvs.setAttribute('tabindex', '0');
  cvs.setAttribute('role', 'application');
  cvs.setAttribute('aria-label', 'Map of Andah. Arrow keys turn the globe, plus and minus zoom, Home resets.');
  cvs.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 15 : 5;
    let used = true;
    switch (e.key) {
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        stopSpin();
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        if (state.alpha < 0.5) {
          state.rotation = [state.rotation[0] + dx, Math.max(-90, Math.min(90, state.rotation[1] - dy))];
        } else {
          state.panX -= dx * 4; state.panY -= dy * 4;
        }
        draw();
        break;
      }
      case '+': case '=': stopSpin(); zoomBy(1.25); break;
      case '-': case '_': stopSpin(); zoomBy(1 / 1.25); break;
      case 'Home': state.zoom = 1; state.panX = 0; state.panY = 0; draw(); break;
      default: used = false;
    }
    if (used) e.preventDefault();
  });

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
    fetch('data/andah-countries.min.geojson').then((r) => r.json()).catch(() => null),
  ]).then(([g, d, city, low]) => {
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
    labelOrder = features.slice().sort((a, b) => b.properties.areaKm2 - a.properties.areaKm2);
    if (low && low.features) {
      for (const f of low.features) {
        if (d3.geoArea(f) > 2 * Math.PI) for (const poly of f.geometry.coordinates) for (const ring of poly) ring.reverse();
      }
      // Draw in the same order, so colours and overlaps match the full mesh.
      const order = new Map(features.map((f, k) => [f.properties.name, k]));
      featuresLow = low.features.slice().sort((a, b) => order.get(a.properties.name) - order.get(b.properties.name));
    }
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
      state.alpha = 1; state.rotation = [0, 0]; state.spinning = false;
      $('toGlobe').classList.remove('on'); $('toFlat').classList.add('on');
    }
    const want = q.get('c') && features.find((f) => f.id === q.get('c'));

    // Sizing is deliberately belt and braces. The canvas can be measured before
    // the page has been laid out, in which case it reports zero and there is
    // nothing sensible to draw into; retry until it reports a real size.
    render();
    let tries = 0;
    // Always repaint after sizing. Assigning to canvas.width clears the canvas
    // even when the value is unchanged, so anything conditional here leaves a
    // blank map behind.
    const settle = () => {
      if (!resize()) return false;
      render();
      window.__map = { canvas: [cvs.width, cvs.height], alpha: state.alpha, rotation: state.rotation.slice(), zoom: state.zoom, labels: lastLabelCount };
      return true;
    };
    // Retry on a timer as well as on animation frames: a browser throttles rAF
    // to nothing in a background tab, so a page that loads while hidden would
    // otherwise stay stuck at the canvas default size until something resized
    // the window.
    const retry = () => { if (!settle() && ++tries < 40) setTimeout(retry, 120); };
    retry();
    requestAnimationFrame(settle);
    window.addEventListener('resize', settle);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { settle(); render(); } });
    if (window.ResizeObserver) new ResizeObserver(settle).observe($('stage'));

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
  $('labels').onclick = () => { state.showLabels = !state.showLabels; $('labels').classList.toggle('on', state.showLabels); draw(); };
  $('theme').onclick = () => setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  $('search').onchange = (e) => {
    const name = e.target.value.trim();
    if (byName.has(name)) { show(name); flyTo(name); e.target.blur(); }
  };
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') show(null); });
})();
