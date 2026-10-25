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
  const PAD = 18;
  const MORPH_MS = 900;

  // Device pixels per CSS pixel. The canvas backing store is sized by the ratio
  // but the context transform is left at identity, so every font size, stroke
  // width and dot radius below is in device pixels and has to be scaled by this
  // or it comes out a third too small on a hidpi screen - which is most of the
  // reason the labels looked like fine print.
  let px = 1;

  /**
   * Continent tints, as hue/saturation/lightness so neighbours can be separated
   * without leaving the family.
   *
   * These used to be seven fully saturated hues with +/-17 degrees of jitter,
   * which put lime beside magenta beside salmon and made the plate read as a
   * quiz board. A printed atlas separates its territories with washes: the
   * saturation stays under a quarter, the hues stay inside an earth range, and
   * the work of telling two countries apart is done by lightness and by the
   * border between them, not by shouting. Hue jitter is +/-4 degrees for the
   * same reason - enough to see a seam, not enough to break the family.
   */
  const LAND = {
    dark: {
      Ayuma: [18, 20, 36],        // terracotta
      Atirha: [205, 18, 37],      // slate
      Acrola: [44, 28, 37],       // ochre
      Mahea: [340, 15, 38],       // dusty rose
      Massir: [128, 14, 35],      // sage
      Quia: [268, 13, 39],        // heather
      'New Ayre': [176, 17, 34],  // verdigris
    },
    light: {
      Ayuma: [20, 34, 79],
      Atirha: [205, 27, 81],
      Acrola: [44, 40, 79],
      Mahea: [340, 29, 82],
      Massir: [124, 21, 79],
      Quia: [266, 23, 83],
      'New Ayre': [176, 25, 79],
    },
  };
  const FALLBACK = { dark: [40, 10, 36], light: [40, 18, 80] };

  // Choropleth ramps. Sepia on ink and sepia on paper, so switching a metric on
  // stays inside the plate's own palette instead of dropping a web-blue scale
  // on top of it.
  // The floor of the dark ramp has to stay clearly lighter and warmer than the
  // ocean. Taken any darker, the lowest bin stops reading as a low value and
  // starts reading as a hole in the plate.
  const RAMPS = {
    dark: ['#413a2d', '#54492f', '#6a5b34', '#82703b', '#9b8544', '#b79c50', '#d6b465'],
    light: ['#f2eadb', '#e4d7ba', '#d4bf95', '#c1a570', '#aa8951', '#8e6b38', '#6f5023'],
  };
  const themeKey = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const ramp = () => RAMPS[themeKey()];

  let geo = null, data = null, cities = [], features = [], byName = new Map(), bounds = new Map();
  // Alphabetical position, printed on each plate. Pure flavour, but it is the
  // sort of detail that separates a reference work from a page of statistics.
  const plateNo = new Map();
  // How much of its own bounding box a country actually fills (near 1 for a
  // solid landmass, near 0 for islands scattered across an ocean), and the
  // angular radius in degrees of a disc of the same area, which is the only
  // honest measure of size for the scattered ones.
  const compact = new Map();
  const discDeg = new Map();
  const SCATTERED = 0.25;
  // "<nation> <city>" -> [lon, lat]. Only used to mark the capital on a plate's
  // silhouette; the city file covers 112 of the 172 nations, so it is always
  // treated as optional.
  const cityIndex = new Map();
  // The coarse geometry by name, for the plate silhouettes.
  const byNameLow = new Map();
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
    const s = Math.min((w - PAD * px * 2) / bw, (h - PAD * px * 2) / bh) * state.zoom;
    const cx = (b[0][0] + b[1][0]) / 2, cy = (b[0][1] + b[1][1]) / 2;
    projection.scale(s).translate([w / 2 - cx * s + state.panX, h / 2 - cy * s + state.panY]);
  }

  // ---------------------------------------------------------------- colours

  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  let bins = null;

  /**
   * The plate's colours, read once per theme.
   *
   * Every one of these lives in the stylesheet so the two themes stay in one
   * place, but resolving a custom property means a getComputedStyle call, and
   * the render path now wants a dozen of them per frame while the globe is
   * spinning at sixty. Cached here and dropped whenever the theme changes.
   */
  let paint = null;
  function palette() {
    if (paint) return paint;
    const g = getComputedStyle(document.documentElement);
    const v = (n) => g.getPropertyValue(n).trim();
    paint = {
      ocean: v('--ocean'), oceanLit: v('--ocean-lit'), oceanDeep: v('--ocean-deep'),
      shelf: v('--shelf'), limb: v('--limb'), graticule: v('--graticule'),
      border: v('--border'), coast: v('--coast'),
      label: v('--label'), halo: v('--label-halo'), city: v('--city'),
      line: v('--line'), dim: v('--dim'), accent: v('--accent'),
    };
    return paint;
  }

  function buildBins() {
    bins = null;
    if (!state.metric) return;
    const vals = features
      .map((f) => valueOf(f.properties.name, state.metric))
      .filter((v) => typeof v === 'number' && Number.isFinite(v))
      .sort((a, b) => a - b);
    const steps = ramp().length;
    if (vals.length < steps) return;
    const cuts = [];
    for (let i = 1; i < steps; i++) cuts.push(vals[Math.floor((i * vals.length) / steps)]);
    bins = { cuts, min: vals[0], max: vals[vals.length - 1] };
  }
  const valueOf = (name, key) => {
    const c = data.countries[name];
    return c && c.metrics ? c.metrics[key] : undefined;
  };
  const hashOf = (s) => {
    let h = 0;
    for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) >>> 0;
    return h;
  };

  function colourOf(f) {
    const name = f.properties.name;
    if (state.metric) {
      const v = valueOf(name, state.metric);
      if (typeof v !== 'number' || !bins) return palette().line;
      let i = 0;
      while (i < bins.cuts.length && v >= bins.cuts[i]) i++;
      return ramp()[i];
    }
    const c = data.countries[name];
    // Heiso is listed as "Ayuma/Acrola". Take the first named continent rather
    // than falling through to a default that would collide with Atirha's slate.
    const cont = (c && c.continent) ? c.continent.split('/')[0].trim() : '';
    const key = themeKey();
    const base = LAND[key][cont] || FALLBACK[key];
    const h = hashOf(name);
    // Lightness carries the separation, hue barely moves.
    return `hsl(${base[0] + (h % 9) - 4} ${base[1]}% ${base[2] + ((h >> 4) % 11) - 5}%)`;
  }

  // ----------------------------------------------------------------- render

  // Moving: anything that will be redrawn again immediately.
  const inMotion = () => !!(morph || drag || touch || (state.spinning && state.alpha === 0));

  /**
   * The water, and the thing that makes it a planet.
   *
   * The ocean used to be a flat fill one shade off the page background, which
   * left the globe with no edge: the continents simply hung in the window. Three
   * passes fix that, all of them keyed to the projected disc:
   *
   *   1. a cast shadow, so the sphere sits in front of the page rather than in it
   *   2. a lit fill, brighter towards the upper left, so the water has a light
   *      source and therefore a form
   *   3. a limb - the darkening in the last fifth of the radius plus a fine
   *      bright line right on the edge - which is what the eye actually reads
   *      as curvature
   *
   * Pass 3 is drawn after the land so the terminator falls across the
   * continents too; a globe shaded only in its water looks like a sticker on a
   * ball. All of it fades out as alpha unrolls the sphere into a flat plate,
   * where curvature would be a lie.
   */
  function discOf() {
    const b = path.bounds(SPHERE);
    return {
      cx: (b[0][0] + b[1][0]) / 2,
      cy: (b[0][1] + b[1][1]) / 2,
      r: Math.max(1, (b[1][0] - b[0][0]) / 2),
    };
  }

  function paintOcean(round) {
    const P = palette();
    const d = discOf();
    ctx.beginPath(); path(SPHERE);
    if (round > 0.01) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.55)';
      ctx.shadowBlur = 34 * px * round;
      ctx.shadowOffsetY = 12 * px * round;
      ctx.fillStyle = P.ocean;
      ctx.fill();
      ctx.restore();
      const g = ctx.createRadialGradient(
        d.cx - d.r * 0.34, d.cy - d.r * 0.4, d.r * 0.05,
        d.cx, d.cy, d.r * 1.25,
      );
      g.addColorStop(0, P.oceanLit);
      g.addColorStop(0.55, P.ocean);
      g.addColorStop(1, P.oceanDeep);
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = P.ocean;
    }
    ctx.fill();
  }

  function paintLimb(round) {
    const P = palette();
    const d = discOf();
    if (round > 0.01) {
      ctx.save();
      ctx.beginPath(); path(SPHERE); ctx.clip();
      // Held to the outer fifth of the disc, and ramped rather than linear. Taken
      // any further in it reads as curvature but costs the countries near the limb
      // their colour, and a plate you cannot read is not worth the illusion.
      const g = ctx.createRadialGradient(d.cx, d.cy, d.r * 0.80, d.cx, d.cy, d.r);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.6, `rgba(0,0,0,${(0.10 * round).toFixed(3)})`);
      g.addColorStop(1, `rgba(0,0,0,${(0.36 * round).toFixed(3)})`);
      ctx.fillStyle = g;
      ctx.fillRect(d.cx - d.r, d.cy - d.r, d.r * 2, d.r * 2);
      ctx.restore();
    }
    // Always outlined. On the globe this line is the limb; unrolled flat it is
    // the plate's own edge, which the flat map had no way of showing at all.
    ctx.beginPath(); path(SPHERE);
    ctx.strokeStyle = P.limb;
    ctx.lineWidth = 1.1 * px;
    ctx.stroke();
  }

  function render() {
    const w = cvs.width, h = cvs.height;
    frame();
    ctx.clearRect(0, 0, w, h);

    const P = palette();
    // 1 on the globe, 0 on the flat plate, and everything between while morphing.
    const round = 1 - Math.min(1, Math.max(0, state.alpha));
    const moving = inMotion();
    const drawSet = (moving && featuresLow) ? featuresLow : features;

    paintOcean(round);

    ctx.beginPath(); path(graticule);
    ctx.strokeStyle = P.graticule; ctx.lineWidth = 0.6 * px; ctx.stroke();

    // The sea shelf: a soft light band hugging every coast, which is how an
    // atlas separates land from water without a heavy outline. Skipped while the
    // map is turning, where it costs a second pass over the whole geometry and
    // nobody can see it anyway.
    if (!moving) {
      ctx.save();
      ctx.beginPath();
      for (const f of drawSet) path(f);
      ctx.shadowColor = P.shelf;
      ctx.shadowBlur = 9 * px;
      ctx.fillStyle = P.ocean;
      ctx.fill(); ctx.fill();      // twice: one pass of shadow is too faint to read
      ctx.restore();
    }

    ctx.lineWidth = (state.zoom > 3 ? 0.7 : 0.5) * px;
    ctx.strokeStyle = P.border;
    for (const f of drawSet) {
      ctx.beginPath(); path(f);
      ctx.fillStyle = colourOf(f);
      ctx.fill();
      ctx.stroke();
    }

    // Coastline over the top of the fills, a touch stronger than the internal
    // borders: on a plate the sea edge always outranks a land frontier.
    if (!moving) {
      ctx.beginPath();
      for (const f of drawSet) path(f);
      ctx.strokeStyle = P.coast;
      ctx.lineWidth = 0.6 * px;
      ctx.stroke();
    }

    for (const name of state.pinned) {
      const f = byName.get(name);
      if (!f) continue;
      ctx.beginPath(); path(f);
      ctx.strokeStyle = P.dim; ctx.lineWidth = 1.6 * px; ctx.stroke();
    }
    if (state.selected && byName.has(state.selected)) {
      ctx.beginPath(); path(byName.get(state.selected));
      ctx.strokeStyle = P.accent; ctx.lineWidth = 2.2 * px; ctx.stroke();
    }

    if (state.showCities && cities.length) drawCities();

    // Curvature goes on last so it falls across the land as well as the water.
    paintLimb(round);

    // Labels are skipped while moving: they cannot be read anyway, and placing
    // them costs a full pass of collision tests. They also sit above the limb,
    // since a name half-swallowed by the terminator is just illegible.
    if (state.showLabels && !moving) drawLabels();
  }

  // Settlements as ringed dots rather than blobs of ink: a pale core inside a
  // dark ring stays visible over a light wash and a dark one alike.
  function drawCities() {
    const ring = palette().halo;
    const core = palette().city;
    for (const c of cities) {
      if (state.alpha < 0.5 && d3.geoDistance(c.ll, centre()) > Math.PI / 2) continue;
      const p = projection(c.ll);
      if (!p || !Number.isFinite(p[0])) continue;
      const r = Math.max(1, Math.min(4.4, Math.sqrt(c.population / 1e6) * 0.95) * Math.min(2, state.zoom)) * px;
      ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 6.283);
      ctx.fillStyle = core; ctx.fill();
      ctx.lineWidth = 0.9 * px; ctx.strokeStyle = ring; ctx.stroke();
    }
  }

  const centre = () => [-state.rotation[0], -state.rotation[1]];

  const SERIF = 'Constantia, "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif';
  const SANS = 'ui-sans-serif, system-ui, "Segoe UI", sans-serif';

  // Canvas has no letter-spacing that can be relied on across browsers, so the
  // spaced caps an atlas uses for its major territories are set by hand. Halo
  // and fill run as separate passes, or the halo of one letter eats the letter
  // before it.
  const spacedWidth = (text, sp) => ctx.measureText(text).width + sp * Math.max(0, text.length - 1);
  function drawSpaced(text, cx, cy, sp) {
    const start = cx - spacedWidth(text, sp) / 2;
    let x = start;
    for (const ch of text) { ctx.strokeText(ch, x, cy); x += ctx.measureText(ch).width + sp; }
    x = start;
    for (const ch of text) { ctx.fillText(ch, x, cy); x += ctx.measureText(ch).width + sp; }
  }

  /**
   * Country names, largest country first, dropped whenever they will not fit.
   *
   * A label is only drawn if it fits inside the country's own projected extent
   * and does not collide with one already placed, so zooming in reveals more
   * names rather than the map showing a hundred overlapping words at once.
   *
   * Size alone is not hierarchy. Every name used to be set in the same face at
   * within five points of the same size, so a nation of 260 million and an
   * island of forty thousand carried identical weight and the plate read as
   * noise. Three tiers now: the major territories in spaced capitals, the
   * middle rank in the text serif, the rest in a small sans held back a little
   * so it reads as a footnote to the plate rather than competing with it.
   */
  const TIERS = [
    { min: 12.6, caps: true, sp: 0.15, font: (s) => `600 ${s}px ${SERIF}`, alpha: 1 },
    { min: 11.0, caps: false, sp: 0.02, font: (s) => `500 ${s}px ${SERIF}`, alpha: 0.95 },
    { min: 0, caps: false, sp: 0, font: (s) => `500 ${s}px ${SANS}`, alpha: 0.76 },
  ];

  /**
   * Is this label actually on the plate?
   *
   * An archipelago's name is set right across its islands, which is correct for
   * an atlas, but it means the anchor sits in open water and the name can run
   * wider than any one island. Unrolled flat, a projection's outline is narrower
   * than its bounding box everywhere except the equator, so such a name can end
   * up printed on the page beside the plate rather than on it - Ashain ran off
   * the eastern edge of the Robinson.
   *
   * Tested against the outline itself rather than by unprojecting the ends:
   * whether a raw projection's inverse reports a point beyond its own outline is
   * up to each projection, and there are five of them here. The sphere path is
   * laid down once by the caller and left as the current path for the whole
   * label pass, which costs one extra stream of the outline per frame.
   */
  const onPlate = (rect, y) =>
    ctx.isPointInPath(rect[0], y) && ctx.isPointInPath(rect[0] + rect[2], y);

  function drawLabels() {
    const placed = [];
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    const onGlobe = state.alpha < 0.5;
    const eye = centre();
    const halo = palette().halo;
    const ink = palette().label;
    const cull = 40 * px;
    // The plate outline, left as the current path for onPlate to test against.
    // Nothing below starts a new path: strokeText and fillText do not use one.
    if (!onGlobe) { ctx.beginPath(); path(SPHERE); }

    for (const f of labelOrder) {
      const anchor = f.properties.label;
      if (!anchor) continue;
      if (onGlobe && d3.geoDistance(anchor, eye) > Math.PI / 2) continue;
      const p = projection(anchor);
      if (!p || !Number.isFinite(p[0])) continue;
      if (p[0] < -cull || p[1] < -cull || p[0] > cvs.width + cull || p[1] > cvs.height + cull) continue;

      /*
       * How big is this country on screen, and may its name overrun it?
       *
       * Two regimes. A solid landmass is measured by projecting the four
       * corners of its bounds - four operations, against streaming the whole
       * outline again for an exact box - and its name has to fit inside that
       * box or it is dropped.
       *
       * A country of scattered islands has no meaningful box: the bounds cover
       * mostly open water, which sized Ashain's name as though it were the
       * largest nation on the plate, and for a country straddling the
       * antimeridian the box is split across both edges of a flat map and means
       * nothing at all. Those are measured instead by the screen size of a disc
       * of the same area, taken along a line of longitude because latitude
       * never wraps. They are also exempt from the fit test: setting an
       * archipelago's name right across its islands is what an atlas does.
       */
      const name = f.properties.name;
      const scattered = (compact.get(name) ?? 1) < SCATTERED;
      let boxW, boxH;
      if (scattered) {
        const q = projection([anchor[0], Math.min(89, anchor[1] + discDeg.get(name))]);
        if (!q || !Number.isFinite(q[0])) continue;
        boxW = boxH = 2 * Math.hypot(q[0] - p[0], q[1] - p[1]);
      } else {
        const b = bounds.get(name);
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const c of [[b[0][0], b[0][1]], [b[1][0], b[0][1]], [b[0][0], b[1][1]], [b[1][0], b[1][1]]]) {
          const q = projection(c);
          if (!q || !Number.isFinite(q[0])) continue;
          if (q[0] < minX) minX = q[0]; if (q[0] > maxX) maxX = q[0];
          if (q[1] < minY) minY = q[1]; if (q[1] > maxY) maxY = q[1];
        }
        boxW = maxX - minX; boxH = maxY - minY;
      }
      if (!Number.isFinite(boxW) || boxH < 11 * px) continue;

      // Sized in CSS pixels, then scaled, so a hidpi screen gets a bigger
      // backing store rather than smaller type.
      //
      const cssSize = Math.max(10, Math.min(17.5, 9.4 + Math.sqrt(boxW / px) * 0.30));
      const tier = TIERS.find((t) => cssSize >= t.min) || TIERS[TIERS.length - 1];
      const size = cssSize * px;
      ctx.font = tier.font(size.toFixed(1));
      const text = tier.caps ? name.toUpperCase() : name;
      const sp = tier.sp * size;
      const tw = spacedWidth(text, sp);
      if (!scattered && tw > boxW * 0.92) continue;         // no room inside the country

      const pad = 3 * px;
      const rect = [p[0] - tw / 2 - pad, p[1] - size * 0.72, tw + pad * 2, size * 1.44];
      if (!onGlobe && !onPlate(rect, p[1])) continue;
      let clash = false;
      for (const r of placed) {
        if (rect[0] < r[0] + r[2] && rect[0] + rect[2] > r[0] && rect[1] < r[1] + r[3] && rect[1] + rect[3] > r[1]) { clash = true; break; }
      }
      if (clash) continue;
      placed.push(rect);

      ctx.lineWidth = 2.7 * px;
      ctx.strokeStyle = halo;
      ctx.fillStyle = ink;
      ctx.globalAlpha = tier.alpha;
      drawSpaced(text, p[0], p[1], sp);
      ctx.globalAlpha = 1;
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

  // ---------------------------------------------------------------- the plate

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const SIL = [172, 126], LOC = 88;

  /**
   * The country's own outline, drawn at the head of its plate.
   *
   * Azimuthal equal area centred on the country itself, so a nation near a pole
   * is not handed the smeared shape a world projection would give it, and two
   * plates can be read against each other without one of them lying about its
   * size. Fitted to the box, so the shape fills the space whatever its aspect.
   */
  function silhouette(f) {
    // The coarse mesh, where there is one. At 172 pixels across, the full
    // outline is 60KB of path data spent on detail no one can see.
    const g = byNameLow.get(f.properties.name) || f;
    const c = d3.geoCentroid(f);
    const proj = d3.geoAzimuthalEqualArea().rotate([-c[0], -c[1]]);
    proj.fitExtent([[4, 4], [SIL[0] - 4, SIL[1] - 4]], g);
    return { d: d3.geoPath(proj)(g) || '', proj };
  }

  /** A thumbnail globe turned to face the country, so the shape has a place. */
  function locator(f) {
    const c = d3.geoCentroid(f);
    const proj = d3.geoOrthographic().rotate([-c[0], -c[1]]).clipAngle(90)
      .fitExtent([[2, 2], [LOC - 2, LOC - 2]], { type: 'Sphere' });
    const p = d3.geoPath(proj);
    const land = [];
    for (const x of (featuresLow || features)) { const s = p(x); if (s) land.push(s); }
    // An island nation is a speck at this size, and a locator that does not
    // locate anything is just a picture of a globe. Ring it when the shape is
    // too small to see on its own.
    let ring = null;
    const b = p.bounds(f);
    if (Math.max(b[1][0] - b[0][0], b[1][1] - b[0][1]) < 14) {
      const q = proj(c);
      if (q && Number.isFinite(q[0])) ring = q;
    }
    return {
      sphere: p({ type: 'Sphere' }) || '', grat: p(graticule) || '',
      land: land.join(''), here: p(f) || '', ring,
    };
  }

  /** Where the capital sits on the silhouette, when the city file knows it. */
  function capitalAt(nation, capital, proj) {
    const ll = cityIndex.get(nation + ' ' + capital);
    if (!ll) return null;
    const q = proj(ll);
    return (q && Number.isFinite(q[0]) && Number.isFinite(q[1])) ? q : null;
  }

  // Stepped opacities of the one accent. A composition of eight groups in eight
  // hues would out-shout the map; in one hue it stays a diagram.
  const OPAC = [1, .78, .62, .5, .4, .32, .26, .21, .17, .14];

  function show(name) {
    state.selected = name;
    const card = $('card'), empty = $('empty');
    // Set both displays explicitly. Clearing the inline style instead would
    // simply hand control back to the stylesheet, where #card is display:none.
    if (!name || !data.countries[name]) {
      card.style.display = 'none'; empty.style.display = 'flex'; draw(); syncUrl(); return;
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
    const nb = ((feature && feature.properties.neighbours) || []).slice().sort((a, b) => b.km - a.km);
    const N = data.countryCount;

    // --- the rank device ----------------------------------------------------
    // Every figure that has a rank is drawn against the other 171. A number on
    // its own is trivia; a number with its position is information.
    const at = (rank) => ((rank - 1) / Math.max(1, N - 1)) * 100;
    const track = (rank, ends) =>
      `<div class="track${ends ? ' ends' : ''}"${ends ? ` data-last="${ordinal(N)}"` : ''}>`
      + `<u></u><i style="left:${at(rank).toFixed(2)}%"></i></div>`;

    const hero = (k, label, kind, unit) => {
      const v = c.metrics[k];
      if (typeof v !== 'number') return '';
      const rank = c.ranks && c.ranks[k];
      return `<div class="hero">
        <div class="lab">${esc(label)}</div>
        <div class="num">${fmt(v, kind)}${unit ? `<u>${esc(unit)}</u>` : ''}</div>
        ${rank ? `<div class="rank">${track(rank)}<div class="pos"><b>${ordinal(rank)}</b> of ${N}</div></div>` : ''}
      </div>`;
    };

    const strip = (m) => {
      const v = c.metrics[m.key];
      if (typeof v !== 'number') return '';
      const rank = c.ranks && c.ranks[m.key];
      return `<li>
        <div class="top">
          <span class="n">${esc(m.label)}</span>
          <span class="v">${fmt(v, m.kind)}${m.unit ? `<s>${esc(m.unit)}</s>` : ''}</span>
        </div>
        ${rank ? `<div class="scale">${track(rank)}`
          // Clamped, so the label still reads as a label at either extreme
          // instead of hanging half off the edge of the column.
          + `<span class="ord" style="left:${Math.min(93, Math.max(7, at(rank))).toFixed(2)}%">${ordinal(rank)}</span></div>` : ''}
      </li>`;
    };

    // "None" is the wiki's way of saying the field is empty. Printed as a value
    // it reads as content and costs a row.
    const EMPTY = /^(none|n\/a|unknown|-|—)$/i;
    const fact = (label, value, stack) => (value == null || value === '' || EMPTY.test(String(value).trim()) ? ''
      : `<div${stack ? ' class="stack"' : ''}><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`);

    const pct = (v) => (+v).toFixed(1).replace(/\.0$/, '') + '%';
    const comp = (list) => {
      if (!list || !list.length) return '';
      const rows = list.slice(0, 10).filter((r) => r && r.label);
      if (!rows.length) return '';
      return `<div class="comp">${rows.map((r, k) =>
        `<span style="width:${Math.max(0, Math.min(100, +r.pct || 0)).toFixed(2)}%;opacity:${OPAC[k] || .12}"></span>`).join('')}</div>`
        + `<div class="key">${rows.map((r, k) =>
          `<div><i style="opacity:${OPAC[k] || .12}"></i><b>${esc(r.label)}</b>`
          + `<s>${r.pct != null ? pct(r.pct) : ''}</s></div>`).join('')}</div>`;
    };

    // --- territory ----------------------------------------------------------
    const sil = feature ? silhouette(feature) : null;
    const loc = feature ? locator(feature) : null;
    const cap = (sil && c.capital) ? capitalAt(name, c.capital, sil.proj) : null;
    const water = i.percentWater == null ? NaN : parseFloat(i.percentWater);
    const events = i.establishedEvents || [];
    const widest = nb.length ? Math.max(...nb.map((n) => n.km)) : 0;

    card.innerHTML = `
      <article class="plate">
        <header class="mast">
          <div class="strap">
            <span class="no">Plate ${String(plateNo.get(name) || 0).padStart(3, '0')}</span>
            ${c.continent ? `<span class="where">${esc(c.continent)}${c.geoscheme ? ` · ${esc(c.geoscheme)}` : ''}</span>` : ''}
          </div>
          <div class="row">
            ${c.flag ? `<figure class="ensign">
              <img src="${esc(c.flag)}" alt="Flag of ${esc(name)}">
              <figcaption>Ensign</figcaption>
            </figure>` : ''}
            <div class="titles">
              <h2>${esc(name)}</h2>
              ${i.longName && i.longName !== name ? `<p class="long">${esc(i.longName)}</p>` : ''}
              ${/*
                  info.nativeName, info.motto and info.anthem are deliberately
                  not shown. On 171 of the 174 country pages the wiki infobox
                  has national_motto holding the pronunciation respelling,
                  national_anthem holding the IPA, and native_name holding
                  "''__'' - <demonym>". Printing them under their own labels
                  would put a pronunciation guide where a motto should be. The
                  two respellings are real, so they are shown as what they are.
                */''}
              ${c.pronunciation || c.ipa ? `<p class="ipa">${esc(c.pronunciation || '')}`
                + `${c.pronunciation && c.ipa ? ' &middot; ' : ''}${esc(c.ipa || '')}</p>` : ''}
            </div>
          </div>
        </header>

        <div class="links">
          <a class="btn" href="${esc(c.wiki)}" target="_blank" rel="noopener">Wiki article ↗</a>
          <button class="btn" id="pin">${state.pinned.includes(name) ? 'Remove from compare' : 'Compare'}</button>
        </div>

        ${sil ? `<section class="fig">
          <h3>Territory <em>${fmt(c.metrics.areaKm2, 'int')} km²</em></h3>
          <div class="shape">
            <svg width="${SIL[0]}" height="${SIL[1]}" viewBox="0 0 ${SIL[0]} ${SIL[1]}" role="img"
                 aria-label="Outline of ${esc(name)}">
              <path class="outline" d="${sil.d}"></path>
              ${cap ? `<circle class="capring" cx="${cap[0].toFixed(1)}" cy="${cap[1].toFixed(1)}" r="3.6"></circle>
                       <circle class="cap" cx="${cap[0].toFixed(1)}" cy="${cap[1].toFixed(1)}" r="2.1"></circle>` : ''}
            </svg>
            ${loc ? `<svg width="${LOC}" height="${LOC}" viewBox="0 0 ${LOC} ${LOC}" role="img"
                 aria-label="${esc(name)} located on the globe">
              <path class="globe-sea" d="${loc.sphere}"></path>
              <path class="grat" d="${loc.grat}"></path>
              <path class="globe-land" d="${loc.land}"></path>
              <path class="globe-here" d="${loc.here}"></path>
              ${loc.ring ? `<circle class="globe-ring" cx="${loc.ring[0].toFixed(1)}" cy="${loc.ring[1].toFixed(1)}" r="7"></circle>` : ''}
            </svg>` : ''}
          </div>
          ${/* Area and density belong to "Where it stands", which gives them
                their rank as well. Repeating them here without one was the
                same fact told twice and told worse. */''}
          <dl class="facts">
            ${fact('Capital', c.capital)}
            ${i.largestCity && i.largestCity !== c.capital ? fact('Largest city', i.largestCity) : ''}
          </dl>
          ${Number.isFinite(water) ? `<p class="comp-note" style="margin:20px 0 10px">Land and water</p>
          <div class="lw">
            <span class="land" style="width:${(100 - water).toFixed(2)}%"></span>
            <span class="water" style="width:${water.toFixed(2)}%"></span>
          </div>
          <p class="comp-note">Land ${pct(100 - water)} · Water ${pct(water)}</p>` : ''}
        </section>` : ''}

        <section class="fig">
          <h3>At a glance</h3>
          ${/* Nominal, not PPP. Both are in "Where it stands" with their ranks;
                the four headline tiles carry the figures actually quoted for a
                country, and nominal is the one this atlas quotes. */''}
          <div class="heroes">
            ${hero('population', 'Population', 'int')}
            ${hero('gdpNominal', 'GDP (nominal)', 'money', 'lahn')}
            ${hero('gdpNomPerCapita', 'Per head (nominal)', 'money0', 'lahn')}
            ${hero('ktdi', 'Development', 'dec3')}
          </div>
        </section>

        <section class="fig">
          <h3>Where it stands <em>among ${N}</em></h3>
          <ol class="strips">${data.metrics.map(strip).join('')}</ol>
        </section>

        ${(i.ethnicBreakdown && i.ethnicBreakdown.length) || (i.religionBreakdown && i.religionBreakdown.length)
          || i.ethnicGroups || i.religion ? `<section class="fig">
          <h3>People</h3>
          ${i.ethnicBreakdown && i.ethnicBreakdown.length
            ? `<p class="comp-note" style="margin:0 0 11px">Ethnic groups</p>${comp(i.ethnicBreakdown)}`
            : (i.ethnicGroups ? `<p class="comp-note">${esc(i.ethnicGroups)}</p>` : '')}
          ${i.religionBreakdown && i.religionBreakdown.length
            ? `<p class="comp-note" style="margin:22px 0 11px">Religion</p>${comp(i.religionBreakdown)}`
            : (i.religion ? `<p class="comp-note">${esc(i.religion)}</p>` : '')}
        </section>` : ''}

        <section class="fig">
          <h3>State</h3>
          <dl class="facts">
            ${fact('System', i.government, true)}
            ${fact('Legislature', i.legislature, true)}
            ${fact('Upper house', i.upperHouse)}
            ${fact('Lower house', i.lowerHouse)}
            ${fact('Official languages', i.officialLanguages, true)}
            ${fact('Regional languages', i.regionalLanguages, true)}
          </dl>
        </section>

        ${events.length ? `<section class="fig">
          <h3>Chronology</h3>
          <div class="tl">
            ${events.map((e) => `<div class="e"><time>${esc(e.date || '')}</time>${esc(e.event || '')}</div>`).join('')}
          </div>
        </section>` : ''}

        <section class="fig">
          <h3>Borders ${nb.length ? `<em>${nb.length}</em>` : ''}</h3>
          ${nb.length ? `<ol class="nb">${nb.map((n) => `<li>
            <button data-go="${esc(n.name)}">
              <div class="top"><b>${esc(n.name)}</b><s>${n.km.toLocaleString()} km</s></div>
              <div class="g"><i style="width:${widest ? (n.km / widest * 100).toFixed(1) : 0}%"></i></div>
            </button>
          </li>`).join('')}</ol>`
            : '<p class="lone">No land borders. An island nation, bounded on every side by water.</p>'}
        </section>

        <section class="fig">
          <h3>Practicalities</h3>
          <dl class="facts">
            ${fact('Demonym', c.demonym)}
            ${fact('Currency', i.currency)}
            ${fact('Time zone', i.timeZone)}
            ${fact('Date format', i.dateFormat)}
            ${fact('Drives on', i.drivesOn)}
            ${fact('Calling code', i.callingCode)}
            ${fact('Internet domain', c.domain || i.cctld)}
          </dl>
        </section>

      </article>`;

    card.scrollTop = 0;
    card.querySelectorAll('[data-go]').forEach((el) => {
      el.onclick = () => { show(el.dataset.go); flyTo(el.dataset.go); };
    });
    const pin = $('pin');
    if (pin) pin.onclick = () => {
      const at2 = state.pinned.indexOf(name);
      if (at2 >= 0) state.pinned.splice(at2, 1);
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

  /**
   * Three ways in, offered on the empty plate.
   *
   * The column previously held a star and two sentences and then four hundred
   * pixels of nothing, which is what a page looks like before anyone has decided
   * what it is for. Naming the extremes gives the reader somewhere to go and
   * quietly teaches what the plates contain.
   */
  function fillStarts() {
    const el = $('starts');
    if (!el) return;
    const picks = [
      ['areaKm2', 'Largest', 'int', ' km²'],
      ['population', 'Most people', 'int', ''],
      ['ktdi', 'Best developed', 'dec3', ''],
    ];
    const rows = [];
    for (const [key, label, kind, unit] of picks) {
      let best = null, top = -Infinity;
      for (const name of Object.keys(data.countries)) {
        if (!byName.has(name)) continue;
        const v = data.countries[name].metrics[key];
        if (typeof v === 'number' && Number.isFinite(v) && v > top) { top = v; best = name; }
      }
      if (!best) continue;
      rows.push(`<button class="start" data-go="${best}">`
        + `<i>${label}</i><b>${best}</b><u>${fmt(top, kind)}${unit}</u></button>`);
    }
    el.innerHTML = rows.join('');
    el.querySelectorAll('[data-go]').forEach((b) => {
      b.onclick = () => { show(b.dataset.go); flyTo(b.dataset.go); };
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
    px = dpr;
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
      + ramp().map((c, k) => `<div class="row"><i style="background:${c}"></i>`
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
    paint = null;                       // the cached plate colours belong to the old theme
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

    const RAD = Math.PI / 180;
    for (const f of features) {
      const name = f.properties.name;
      const b = d3.geoBounds(f);
      byName.set(name, f);
      bounds.set(name, b);
      // Spherical area of the bounding box: the longitude span in radians times
      // the difference of the sines of the latitudes. Ashain straddles the
      // antimeridian, so d3 reports its bounds running east from 141 to -160
      // and the raw span comes out negative; unwrapped it is 59 degrees, not
      // -301. Left unhandled this made every size derived from it NaN.
      let lonSpan = b[1][0] - b[0][0];
      if (lonSpan < 0) lonSpan += 360;
      const box = lonSpan * RAD * (Math.sin(b[1][1] * RAD) - Math.sin(b[0][1] * RAD));
      const area = d3.geoArea(f);
      compact.set(name, box > 1e-9 ? Math.min(1, area / box) : 1);
      discDeg.set(name, Math.sqrt(area / Math.PI) / RAD);
    }
    features.map((f) => f.properties.name).sort((a, b) => a.localeCompare(b))
      .forEach((n, k) => plateNo.set(n, k + 1));
    labelOrder = features.slice().sort((a, b) => b.properties.areaKm2 - a.properties.areaKm2);
    if (low && low.features) {
      for (const f of low.features) {
        if (d3.geoArea(f) > 2 * Math.PI) for (const poly of f.geometry.coordinates) for (const ring of poly) ring.reverse();
      }
      // Draw in the same order, so colours and overlaps match the full mesh.
      const order = new Map(features.map((f, k) => [f.properties.name, k]));
      featuresLow = low.features.slice().sort((a, b) => order.get(a.properties.name) - order.get(b.properties.name));
      for (const f of featuresLow) byNameLow.set(f.properties.name, f);
    }
    if (city && city.map) {
      const ll = (c) => [(c.x / city.map.width) * 360 - 180, 90 - (c.y / city.map.height) * 180];
      cities = city.cities.map((c) => ({ population: c.population || 0, ll: ll(c) }))
        .sort((a, b) => b.population - a.population);
      for (const c of city.cities) {
        if (c.city && c.nation) cityIndex.set(c.nation + ' ' + c.city, ll(c));
      }
    }

    fillStarts();
    $('countrylist').innerHTML = features.map((f) => `<option value="${f.properties.name}">`).join('');
    $('metric').innerHTML = '<option value="">Colour by continent</option>'
      + data.metrics.map((m) => `<option value="${m.key}">${m.label}</option>`).join('');

    // Restore whatever the URL and last visit asked for.
    try { setTheme(localStorage.getItem('andah-map-theme') || 'dark'); } catch (e) { setTheme('dark'); }
    const q = new URLSearchParams(location.search);
    if (q.get('p')) { state.flat = q.get('p'); $('proj').value = state.flat; }
    if (q.get('m')) {
      state.metric = q.get('m'); $('metric').value = state.metric;
      $('metric').classList.add('on');
      buildBins(); drawLegend();
    }
    if (q.get('v') === 'flat') {
      state.alpha = 1; state.rotation = [0, 0]; state.spinning = false;
      $('toGlobe').classList.remove('on'); $('toFlat').classList.add('on');
    }
    syncProj();
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

  // The projection picker governs the flat plate only, so it is live only there.
  const syncProj = () => { $('proj').disabled = state.alpha < 0.5; };
  $('toGlobe').onclick = () => {
    $('toGlobe').classList.add('on'); $('toFlat').classList.remove('on');
    state.panX = 0; state.panY = 0;
    morphTo(0, () => { syncProj(); syncUrl(); });
  };
  $('toFlat').onclick = () => {
    $('toFlat').classList.add('on'); $('toGlobe').classList.remove('on');
    syncProj();
    morphTo(1, syncUrl);
  };
  $('proj').onchange = (e) => { state.flat = e.target.value; draw(); syncUrl(); };
  $('metric').onchange = (e) => {
    state.metric = e.target.value;
    $('metric').classList.toggle('on', !!state.metric);
    buildBins(); drawLegend(); draw(); syncUrl();
  };
  $('cities').onclick = () => { state.showCities = !state.showCities; $('cities').classList.toggle('on', state.showCities); draw(); };
  $('labels').onclick = () => { state.showLabels = !state.showLabels; $('labels').classList.toggle('on', state.showLabels); draw(); };
  $('theme').onclick = () => setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  $('search').onchange = (e) => {
    const name = e.target.value.trim();
    if (byName.has(name)) { show(name); flyTo(name); e.target.blur(); }
  };
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') show(null); });
})();
