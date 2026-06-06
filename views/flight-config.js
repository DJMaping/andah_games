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
    // demand = (popA*popB)^alpha * gdpFactor / distance^beta, then normalised 0..1.
    alpha: 0.8,
    beta: 1.4,

    // --- Hubs -------------------------------------------------------------
    // Top-N countries by nominal GDP become hubs: they interconnect freely and
    // are exempt from the range cap (long-haul flagships).
    hubCount: 18,

    // --- Filtering / realism ---------------------------------------------
    demandThreshold: 0.03,      // drop hub/spoke edges below this normalised demand
    spokeSpokeThreshold: 0.18,  // two non-hubs only link if demand is this strong
    maxRangeKm: 9000,           // cut routes beyond this unless both endpoints are hubs
    spokeHubs: 3,               // each non-hub is guaranteed links to its nearest N hubs
    maxRoutesPerCity: 6,        // degree cap for non-hubs (highest demand kept)
    hubMaxRoutes: 28,           // degree cap for hubs

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
    // Point radius (globe) / dot radius (map) scale with sqrt(population).
    pointMinRadius: 0.18,
    pointMaxRadius: 0.9,
    // Arc styling
    arcAltitudeMin: 0.05,
    arcAltitudeMax: 0.35,
    arcStrokeMin: 0.2,
    arcStrokeMax: 1.2,
    dimOpacity: 0.06            // opacity of non-selected routes when a city is selected
};
