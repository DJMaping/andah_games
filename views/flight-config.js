// Flight Network — all model + render tunables in one place.
//
// Imported by BOTH the browser (views) and the Node build script
// (scripts/generate-routes.js), so it must stay free of any browser- or
// Node-specific globals. Tweak these to reshape the network; nothing else needs
// to change.

export const FLIGHT_CONFIG = {
    // --- Distance ---------------------------------------------------------
    // 'haversine' = great-circle on the derived lat/lon (matches the globe's
    // arcs). 'pixel' = flat Euclidean distance on map.png scaled by kmPerPixel
    // (avoids equirectangular stretch; handy if the world isn't really a sphere).
    distanceMode: 'haversine',
    planetRadiusKm: 6371,
    kmPerPixel: 6,
    // Floor used in the demand denominator so very close cities don't produce
    // runaway demand that flattens the 0..1 normalisation for everyone else.
    minDistanceKm: 100,

    // --- Gravity demand model --------------------------------------------
    // base   = (massA*massB)^alpha / distance^beta     (mass = pop × nation GDP/cap)
    // demand = base × (domestic ? domesticDemandMult : 1) × min(wealthFactorA, wealthFactorB)
    // then normalised by max(base) so domestic boosts lift above the intl scale.
    alpha: 0.8,
    beta: 1.15,                  // gentler distance decay -> more medium/long routes between big cities

    // --- Hubs -------------------------------------------------------------
    // GLOBAL hubs = the top-N airports by blended node weight (economic mass +
    // raw population; see popWeight). They interconnect freely, are exempt from
    // the range cap (long-haul flagships), and get a high degree-cap floor so they
    // fan out nearly everywhere (see hubCapFloor below).
    hubCount: 36,
    // Blend raw population into hub ranking AND route demand: 0 = pure economic mass
    // (old behaviour), 1 = pure population. At 0.5 (with the wider hubCount above)
    // megacity capitals in poor nations — e.g. Nakos & Mihkose in Ztesh — qualify as
    // hubs and earn long-haul trunk routes, without erasing the wealth signal.
    popWeight: 0.5,
    // Global trunk network: every pair of hubs within this range gets a
    // guaranteed long-haul route (the real-world "London <-> Moscow/Rio/Dubai/NYC"
    // flagship mesh), so the major world cities all interconnect regardless of
    // distance decay. Set high; pairs beyond it (near-antipodal) are skipped.
    hubMeshMaxKm: 16000,
    // Gentler distance decay for hub<->hub demand: trunk routes between megacities
    // stay high-volume (thick arcs) even at long haul, unlike ordinary routes.
    betaHub: 0.6,

    // --- Domestic / wealth scaling ---------------------------------------
    // The network favours same-country flights and gives rich nations far more
    // routes than poor ones. "Rich" is driven by GDP-PER-CAPITA (a populous but
    // poor nation stays sparse on purpose).
    domesticDemandMult: 5.0,    // same-country pairs get this demand multiplier (pre-normalisation)
    wealthExp: 1.0,             // shapes the nation wealth factor; >1 punishes poor nations harder
    wealthFloor: 0.06,          // poorest nations keep at least this fraction of demand / cap
    // Capitals are diplomatic/economic anchors that often out-fly their raw size
    // (the seat of government isn't always the biggest city). capitalBoost lifts a
    // capital's effective mass (-> more demand + likelier to be a hub); capitalCapBonus
    // adds flat extra routes to its degree cap so it fans out even when not the largest.
    capitalBoost: 2.2,          // multiplier on a capital's economic mass (demand + hub ranking)
    capitalCapBonus: 6,         // flat extra routes added to a capital's degree cap
    // Manual per-city spotlight, keyed by city id: multiplies that city's effective
    // mass (more demand + better hub ranking) AND its route-count ceiling, so a
    // hand-picked city flies more than its population/GDP alone would earn. 1 = none.
    cityBoost: {
        faramozan: 1.4,
        veshgadar: 1.4
    },
    // Per-airport degree cap = a BLEND of nation wealth and city POPULATION:
    //   cap = capMin + (capMax-capMin) × (wealthWeight·wealth^capWealthExp
    //                                     + (1-wealthWeight)·popFraction^sizeExp)
    // Wealth still leads (wealthWeight > 0.5), but a populous nation's big cities
    // now get real lift from population even when poor — so a huge poor country
    // isn't starved down to 2-3 routes a city.
    wealthWeight: 0.55,         // wealth vs population split in the cap (>0.5 = wealth leads)
    capMin: 4,                  // cap floor for the poorest / smallest cities
    capMax: 85,                 // cap ceiling for the richest / largest cities
    capWealthExp: 1.0,          // exponent applying wealth to the cap
    sizeExp: 0.7,               // exponent on the population fraction (compresses the long tail)
    hubCapFloor: 52,            // minimum cap for a global hub (fly nearly everywhere)
    capHardMin: 1,              // absolute lower clamp on any cap
    capHardMax: null,           // no absolute upper clamp — busy hubs are free to accumulate routes

    // --- Filtering / realism ---------------------------------------------
    // Thresholds are near-zero: with mass = pop × GDP/capita the demand spread is
    // enormous, so the per-airport scaled cap (above) is the real limiter, not a
    // global demand cutoff. Keep tiny floors just to drop numerically-dead edges.
    demandThreshold: 0.0,       // hub/spoke edges: cap decides, not a cutoff
    spokeSpokeThreshold: 0.0,   // spoke-spoke edges: cap decides
    maxRangeKm: 11000,          // cut routes beyond this unless both endpoints are hubs
    spokeHubs: 1,               // each non-hub is guaranteed a link to its nearest hub (anti-stranding)

    // --- Haul classification (km) ----------------------------------------
    haulShortMax: 1500,         // short  < 1500
    haulMediumMax: 4000,        // medium 1500..4000 ; long > 4000

    // --- Render -----------------------------------------------------------
    haulColors: {
        short: '#2e9e8f',       // teal
        medium: '#e0a33c',      // amber
        long: '#d65a45'         // terracotta
    },
    hubColor: '#f2c14e',
    pointColor: '#4a90d9',
    selectedColor: '#ffffff',
    // Airport dots are colour-coded by connectivity (non-stop destinations =
    // node degree). Bands + colours match the on-map "Airport legend".
    degreeBands: [
        { min: 100, color: '#12306b', label: '> 100 non-stop destinations' },
        { min: 30,  color: '#2f7fe0', label: '> 30 non-stop destinations' },
        { min: 7,   color: '#d6a425', label: '> 7 non-stop destinations' },
        { min: 0,   color: '#cf4036', label: '< 7 non-stop destinations' }
    ],
    // Point radius (globe) / dot radius (map) scale with sqrt(population).
    pointMinRadius: 0.18,
    pointMaxRadius: 0.9,
    // Arc styling
    arcAltitudeMin: 0.05,
    arcAltitudeMax: 0.35,
    arcStrokeMin: 0.1,
    arcStrokeMax: 0.3,          // keep arcs very thin: even top-demand trunk/domestic edges stay slim
    dimOpacity: 0.06,           // opacity of non-selected routes when a city is selected

    // --- Performance ------------------------------------------------------
    // globe.gl tessellates each arc into this many segments. Default is 64;
    // arcs sit flat on the surface (arcAltitude 0) so ~28 looks identical while
    // roughly halving arc geometry — speeds up first paint and every selection.
    arcCurveResolution: 28,
    // When NO city is selected and the 2D map is zoomed out (fit-to-width), skip
    // routes whose normalised demand (0..1) is below this — they render as
    // near-invisible hairlines anyway. 0 = full fidelity: draw EVERY route at all
    // times (the offscreen cache keeps that fast). Raise it (e.g. 0.04) only if a
    // weak machine needs to shed faint hairlines when zoomed out.
    mapMinDemandZoomedOut: 0
};

// Dot colour for an airport's connectivity (degree = number of non-stop
// destinations). Bands are checked high-to-low; the last band is the fallback.
export function degreeColor(degree, config = FLIGHT_CONFIG) {
    const d = degree || 0;
    const bands = config.degreeBands || [];
    for (const b of bands) if (d > b.min) return b.color;
    return bands.length ? bands[bands.length - 1].color : config.pointColor;
}
