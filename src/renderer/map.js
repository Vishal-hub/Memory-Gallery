import { state, ui } from './state.js';

let _graphCallbacks = { openCluster: null, renderClusters: null, updateNavActiveState: null };

export function registerGraphCallbacks(callbacks) {
    Object.assign(_graphCallbacks, callbacks);
}

const MAP_WORLD_BOUNDS = [[-85, -180], [85, 180]];
const MAP_MIN_ZOOM = 2;

const MAP_TILE_STYLES = {
    voyager: {
        url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
        options: {
            subdomains: 'abcd',
            maxZoom: 20,
            attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
        },
    },
    positron: {
        url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
        options: {
            subdomains: 'abcd',
            maxZoom: 20,
            attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
        },
    },
    darkmatter: {
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        options: {
            subdomains: 'abcd',
            maxZoom: 20,
            attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
        },
    },
};

export function setMapStyle(styleKey = 'voyager') {
    if (!state.map) return;
    const style = MAP_TILE_STYLES[styleKey] || MAP_TILE_STYLES.voyager;
    state.map.eachLayer((layer) => {
        if (layer instanceof L.TileLayer) {
            state.map.removeLayer(layer);
        }
    });
    state.mapTileLayer = L.tileLayer(style.url, style.options).addTo(state.map);
    state.currentMapStyle = styleKey;
    if (ui.mapStyleSelect) {
        const trigger = ui.mapStyleSelect.querySelector('.dropdown-trigger');
        if (trigger) {
            const label = trigger.querySelector('.dropdown-label');
            const item = ui.mapStyleSelect.querySelector(`.dropdown-item[data-value="${styleKey}"]`);
            if (item) {
                ui.mapStyleSelect.querySelectorAll('.dropdown-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
                if (label) label.innerText = item.innerText;
            }
        }
    }
}

function getClusterLatLon(cluster) {
    const fallback = cluster.items?.find((it) => typeof it.latitude === 'number' && typeof it.longitude === 'number');
    const lat = typeof cluster.centerLat === 'number' ? cluster.centerLat : fallback?.latitude;
    const lon = typeof cluster.centerLon === 'number' ? cluster.centerLon : fallback?.longitude;
    if (typeof lat === 'number' && typeof lon === 'number') return { lat, lon };
    return null;
}

function getMapClusterBounds(clusters) {
    const bounds = [];
    clusters.forEach((cluster) => {
        const pos = getClusterLatLon(cluster);
        if (pos) bounds.push([pos.lat, pos.lon]);
    });
    return bounds;
}

export function fitMapToClusters(clusters, { padding = [40, 40] } = {}) {
    if (!state.map) return;
    const bounds = getMapClusterBounds(clusters);
    state.mapSearchLocked = false;
    state.mapFitting = true;
    if (ui.fitMapBtn) ui.fitMapBtn.classList.add('hidden');
    if (bounds.length > 0) {
        state.map.fitBounds(bounds, { padding, maxZoom: 7 });
        if (state.map.getZoom() < MAP_MIN_ZOOM) {
            state.map.setView(state.map.getCenter(), MAP_MIN_ZOOM, { animate: false });
        }
        state.mapLockedLat = state.map.getCenter().lat;
        setTimeout(() => { state.mapFitting = false; }, 800);
        return;
    }

    state.map.fitBounds(MAP_WORLD_BOUNDS, { padding: [20, 20], maxZoom: MAP_MIN_ZOOM });
    state.mapLockedLat = state.map.getCenter().lat;
    setTimeout(() => { state.mapFitting = false; }, 800);
}

function updateModeToolbar() {
    if (ui.timelineWrap) {
        ui.timelineWrap.classList.toggle('hidden', state.showMap);
    }
    if (ui.groupByWrap) ui.groupByWrap.classList.toggle('hidden', state.showMap);
    if (ui.uiFiltersWrap) ui.uiFiltersWrap.classList.toggle('hidden', state.showMap);
    if (ui.mapModeWrap) {
        ui.mapModeWrap.classList.toggle('hidden', !state.showMap);
    }
}

export { updateModeToolbar };

function updateMapModeMeta(clusters = state.filteredClusters) {
    if (!ui.mapModeMeta) return;
    const placeCount = clusters.filter((cluster) =>
        typeof cluster.centerLat === 'number' && typeof cluster.centerLon === 'number'
    ).length;
    const itemCount = clusters.reduce((sum, cluster) => sum + (cluster.itemCount || cluster.items?.length || 0), 0);
    ui.mapModeMeta.innerText = `${placeCount} place${placeCount === 1 ? '' : 's'} · ${itemCount} item${itemCount === 1 ? '' : 's'}`;
}

function focusClusterFromMap(clusterId) {
    const cluster = state.filteredClusters.find((entry) => entry.id === clusterId);
    if (!cluster) return;

    state.openedFromMap = true;
    state.showMap = false;
    ui.mapPanel.classList.add('hidden');
    _graphCallbacks.openCluster(clusterId);
}

export { focusClusterFromMap };

function initMap() {
    if (!state.map) {
        state.map = L.map('map', {
            zoomControl: false,
            minZoom: MAP_MIN_ZOOM,
            worldCopyJump: true,
            maxBoundsViscosity: 1.0,
            maxBounds: [[-85, -Infinity], [85, Infinity]],
        }).setView([20, 0], MAP_MIN_ZOOM);
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Tiles © Esri',
            maxZoom: 19,
        }).addTo(state.map);
        setMapStyle(state.currentMapStyle);
        L.control.zoom({ position: 'topright' }).addTo(state.map);

        const mapContainer = state.map.getContainer();
        mapContainer.addEventListener('wheel', (e) => {
            if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
                state.map.panBy([e.deltaX, 0], { animate: false });
                e.preventDefault();
                e.stopPropagation();
            }
        }, { capture: true, passive: false });

        state.map.on('dragstart', () => {
            state.mapLockedLat = state.map.getCenter().lat;
        });
        state.map.on('drag', () => {
            if (typeof state.mapLockedLat === 'number') {
                const center = state.map.getCenter();
                state.map.setView([state.mapLockedLat, center.lng], state.map.getZoom(), { animate: false });
            }
        });
        state.map.on('movestart', () => {
            if (state.showMap && !state.mapFitting && ui.fitMapBtn) {
                ui.fitMapBtn.classList.remove('hidden');
            }
        });
    }
    updateMapMarkers(state.filteredClusters);
}

export { initMap };

let _markerLayer = null;

function buildMarkers(clusters) {
    if (!_markerLayer) {
        _markerLayer = L.layerGroup().addTo(state.map);
    }
    _markerLayer.clearLayers();
    state.mapMarkers = [];
    clusters.forEach((cluster) => {
        const pos = getClusterLatLon(cluster);
        if (!pos) return;
        const { lat, lon } = pos;
        const formattedDate = new Date(cluster.startTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const itemCount = cluster.itemCount || cluster.items.length;
        const popupHtml = `
        <div class="map-popup" data-cluster-id="${cluster.id}">
          <div class="map-popup-place">${cluster.placeName || 'Unknown Place'}</div>
          <div class="map-popup-meta">
            <span class="map-popup-date">📅 ${formattedDate}</span>
            <span class="map-popup-items">🖼 ${itemCount} item${itemCount !== 1 ? 's' : ''}</span>
          </div>
          <button class="map-popup-link" type="button" data-cluster-id="${cluster.id}">Open Cluster →</button>
        </div>
      `;
        const marker = L.marker([lat, lon]).bindPopup(popupHtml);
        _markerLayer.addLayer(marker);
        state.mapMarkers.push(marker);
    });
}

export function updateMapMarkers(clusters, { skipFitMap = false } = {}) {
    if (!state.map) return;
    updateMapModeMeta(clusters);
    buildMarkers(clusters);
    if (!skipFitMap && !state.mapSearchLocked) fitMapToClusters(clusters);
}

export function setMapVisibility(show, { skipRender = false } = {}) {
    if (show) {
        state.inDetailsView = false;
    }
    state.showMap = show;
    ui.mapPanel.classList.toggle('hidden', !show);
    updateModeToolbar();
    _graphCallbacks.updateNavActiveState();
    if (show) {
        state.mapSearchLocked = false;
        if (ui.fitMapBtn) ui.fitMapBtn.classList.add('hidden');
        initMap();
        setTimeout(() => {
            state.map.invalidateSize(false);
            updateMapMarkers(state.filteredClusters);
        }, 200);
    } else if (!skipRender) {
        _graphCallbacks.renderClusters(state.filteredClusters);
    }
}
