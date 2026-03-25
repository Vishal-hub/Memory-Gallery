(function bootstrap() {
  const GRAPH = {
    width: 2400,
    height: 800,
    nodeWidth: 140,
    nodeHeight: 150,
    lanes: 3,
    gapX: 185,
    startX: 120,
    startY: 80,
    laneGap: 120,
  };

  const state = {
    scale: 1,
    offsetX: 30,
    offsetY: 30,
    idealOffsetX: 0,
    idealOffsetY: 0,
    isDraggingViewport: false,
    dragMoved: false,
    dragStartClientX: 0,
    dragStartClientY: 0,
    startOffsetX: 0,
    startOffsetY: 0,
    suppressClickUntil: 0,
    allClusters: [],
    filteredClusters: [],
    searchQuery: '',
    faceFilter: null,
    groupBy: 'date',
    semanticMatches: [],
    inDetailsView: false,
    lastPositions: [],
    clusterElements: new Map(),
    draggedNodeId: null,
    nodeDragMoved: false,
    map: null,
    mapTileLayer: null,
    mapMarkers: [],
    mapLockedLat: null,
    syncingMapLatitude: false,
    showMap: false,
    currentMapStyle: 'voyager',
    mapSearchLocked: false,
    people: [],
    personFilter: null,
    libraryDirty: false,
    navigationToken: 0,
    dragStartLng: null,
  };

  const ui = {
    viewport: document.getElementById('viewport'),
    gallery: document.getElementById('gallery'),
    connections: document.getElementById('connections'),
    status: document.getElementById('status'),
    debug: document.getElementById('debug'),
    slider: document.getElementById('timeline'),
    timelineWrap: document.getElementById('timelineWrap'),
    timeLabel: document.getElementById('timeLabel'),
    manageFoldersBtn: document.getElementById('manageFoldersBtn'),
    settingsModal: document.getElementById('settingsModal'),
    rootsList: document.getElementById('rootsList'),
    addFolderBtn: document.getElementById('addFolderBtn'),
    saveSettingsBtn: document.getElementById('saveSettingsBtn'),
    closeSettingsBtn: document.getElementById('closeSettingsBtn'),
    includeVideosCheckbox: document.getElementById('includeVideosCheckbox'),
    refreshLibraryBtn: document.getElementById('refreshLibraryBtn'),
    searchInput: document.getElementById('searchInput'),
    clearSearchBtn: document.getElementById('clearSearchBtn'),
    filterPortraitBtn: document.getElementById('filterPortraitBtn'),
    filterGroupBtn: document.getElementById('filterGroupBtn'),
    floatingRecenterBtn: document.getElementById('floatingRecenterBtn'),
    clearCacheActionBtn: document.getElementById('clearCacheActionBtn'),
    groupBySelect: document.getElementById('groupByDropdown'),
    mapPanel: document.getElementById('map-panel'),
    mapModeWrap: document.getElementById('mapModeWrap'),
    mapModeMeta: document.getElementById('mapModeMeta'),
    fitMapBtn: document.getElementById('fitMapBtn'),
    mapStyleSelect: document.getElementById('mapStyleDropdown'),
    navTimeline: document.getElementById('navTimeline'),
    navPeople: document.getElementById('navPeople'),
    navMap: document.getElementById('navMap'),
    renameModal: document.getElementById('renameModal'),
    renameInput: document.getElementById('renameInput'),
    closeRenameBtn: document.getElementById('closeRenameBtn'),
    saveRenameBtn: document.getElementById('saveRenameBtn'),
  };

  // DIAGNOSTIC CHECK
  const critical = ['viewport', 'gallery', 'connections', 'status'];
  const missing = critical.filter(k => !ui[k]);
  if (missing.length > 0) {
    console.error('MISSING CRITICAL UI ELEMENTS:', missing);
  }

  function toFileSrc(filePath) {
    return encodeURI(`file:///${filePath.replace(/\\/g, '/')}`);
  }

  function formatDate(timestamp) {
    return new Date(timestamp).toLocaleString();
  }

  function formatLocation(lat, lon) {
    if (typeof lat !== 'number' || typeof lon !== 'number') return 'Unknown location';
    return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  }

  let lastUserActivityPingAt = 0;

  function notifyUserActivity(force = false) {
    if (!window.api || typeof window.api.send !== 'function') return;
    const now = Date.now();
    if (!force && now - lastUserActivityPingAt < 250) return;
    lastUserActivityPingAt = now;
    window.api.send('user-activity');
  }

  function bindUserActivitySignals() {
    const passive = { passive: true };
    window.addEventListener('pointerdown', () => notifyUserActivity(true), passive);
    window.addEventListener('mousemove', () => notifyUserActivity(false), passive);
    window.addEventListener('wheel', () => notifyUserActivity(false), passive);
    window.addEventListener('keydown', () => notifyUserActivity(true));
    window.addEventListener('focus', () => notifyUserActivity(true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        notifyUserActivity(true);
      }
    });
  }

  function stableRandomY(seed, max) {
    const x = Math.sin(seed) * 10000;
    return Math.floor((x - Math.floor(x)) * Math.max(1, max));
  }

  function setTransform() {
    if (state.inDetailsView) {
      if (ui.floatingRecenterBtn) ui.floatingRecenterBtn.classList.add('hidden');
    } else {
      const movedX = Math.abs(state.offsetX - state.idealOffsetX) > 8;
      const movedY = Math.abs(state.offsetY - state.idealOffsetY) > 8;
      const zoomed = Math.abs(state.scale - 1.0) > 0.02;

      const isOffCenter = movedX || movedY || zoomed;

      if (ui.floatingRecenterBtn) {
        ui.floatingRecenterBtn.classList.toggle('hidden', !isOffCenter);
      }
    }

    const transform = `translate(${state.offsetX}px, ${state.offsetY}px) scale(${state.scale})`;
    ui.gallery.style.transform = transform;
    ui.connections.style.transform = transform;

    const outThreshold = 0.75;
    const outEnd = 0.18;
    const morphFactor = Math.max(0, Math.min(1, (outThreshold - state.scale) / (outThreshold - outEnd)));

    updateMorphedLayout(morphFactor);
  }

  function resetViewportContext() {
    state.inDetailsView = false;
    state.openedFromMap = false;
    state.openedFromPeople = false;
    if (ui.viewport) {
      ui.viewport.classList.remove('scrollable-mode');
      ui.viewport.style.overflow = 'hidden';
      ui.viewport.style.cursor = 'grab';
    }
    if (ui.gallery) {
      ui.gallery.style.position = 'absolute';
      ui.gallery.style.height = '100%';
    }
  }

  function updateMorphedLayout(morphFactor) {
    if (!state.lastPositions || state.lastPositions.length === 0) return;

    // Center circle in the ACTUAL world (not a huge separate space)
    const centerX = GRAPH.width / 2;
    const centerY = GRAPH.height / 2;

    const count = state.lastPositions.length;
    const circleRadius = Math.min(GRAPH.height / 2 - 80, Math.max(250, count * 18));

    const morphedPositions = state.lastPositions.map((pos, i) => {
      // 1. WAVE POSITION (Chronological Base)
      const waveX = GRAPH.startX + i * GRAPH.gapX;
      const lane = Math.abs((i % 4) - 2);
      const waveY = GRAPH.startY + lane * GRAPH.laneGap;

      // 2. CIRCLE POSITION (Zoom-Out Target)
      const angle = (i / count) * Math.PI * 2;
      const circleX = centerX + circleRadius * Math.cos(angle);
      const circleY = centerY + circleRadius * Math.sin(angle);

      // INTERPOLATE
      let x = waveX;
      let y = waveY;

      if (morphFactor > 0) {
        x = waveX * (1 - morphFactor) + circleX * morphFactor;
        y = waveY * (1 - morphFactor) + circleY * morphFactor;
      }

      // Update DOM
      const el = state.clusterElements.get(pos.id);
      if (el) {
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
      }

      return { ...pos, x, y };
    });

    redrawConnections(morphedPositions, morphFactor);
  }

  function redrawConnections(positions, morphFactor = 0) {
    if (!positions || positions.length < 2) {
      ui.connections.innerHTML = '';
      return;
    }

    // Performance: Only clear if needed, but for <100 nodes, replacement is fine
    ui.connections.innerHTML = '';
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < positions.length - 1; i++) {
      const pos = positions[i];
      const next = positions[i + 1];

      const el = state.clusterElements.get(pos.id);
      const nextEl = state.clusterElements.get(next.id);

      const startWidth = el ? el.offsetWidth : GRAPH.nodeWidth;
      const startHeight = el ? el.offsetHeight : GRAPH.nodeHeight;
      const endHeight = nextEl ? nextEl.offsetHeight : GRAPH.nodeHeight;

      const startX = pos.x + startWidth;
      const startY = pos.y + startHeight / 2;
      const endX = next.x;
      const endY = next.y + endHeight / 2;

      // STRETCHING LOGIC: Flatten curves as we zoom out/morph
      const curveIntensity = 1 - Math.min(1, morphFactor * 1.2);
      const cpDistance = Math.max(0, (endX - startX) * 0.8 * curveIntensity);

      const cp1X = startX + cpDistance;
      const cp1Y = startY;
      const cp2X = endX - cpDistance;
      const cp2Y = endY;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const d = `M ${startX} ${startY} C ${cp1X} ${cp1Y}, ${cp2X} ${cp2Y}, ${endX} ${endY}`;
      path.setAttribute('d', d);

      // PLAYFUL STAGGERED FADE
      // Lines closer to the start of the timeline fade slightly differently
      const staggerDelay = i * 0.015;
      const segmentOpacity = Math.max(0, 1 - (morphFactor * 3.5 + staggerDelay));
      path.style.opacity = segmentOpacity;

      // DASH STRETCHING: Dashes "pull apart" as we zoom out
      const dashBase = 8;
      const dashGap = 8 + morphFactor * 40;
      path.style.strokeDasharray = `${dashBase} ${dashGap}`;
      path.style.strokeWidth = Math.max(3, 4 / state.scale);

      fragment.appendChild(path);
    }

    ui.connections.appendChild(fragment);
  }

  function setGraphTransformEnabled(enabled) {
    ui.connections.style.display = enabled ? 'block' : 'none';
    if (enabled) {
      setTransform();
    } else {
      ui.gallery.style.transform = 'none';
      ui.connections.style.transform = 'none';
    }
  }

  function centerOnPositions(positions) {
    if (!positions || positions.length === 0) return;

    // 1. FORCE SCALE TO 1.0 (no morph at this scale)
    state.scale = 1.0;
    state.idealScale = 1; // ✅ IMPORTANT
    // 2. RESET ALL NODES TO PURE WAVE POSITIONS
    positions.forEach((pos, i) => {
      const waveX = GRAPH.startX + i * GRAPH.gapX;
      const lane = Math.abs((i % 4) - 2);
      const waveY = GRAPH.startY + lane * GRAPH.laneGap;
      pos.x = waveX;
      pos.y = waveY;
      const el = state.clusterElements.get(pos.id);
      if (el) {
        el.style.left = `${waveX}px`;
        el.style.top = `${waveY}px`;
      }
    });

    // 3. CALCULATE PERFECT CENTERING
    const margin = 36;
    const xValues = positions.map((p) => p.x);
    const yValues = positions.map((p) => p.y);
    const minX = Math.min(...xValues);
    const maxX = Math.max(...xValues);
    const minY = Math.min(...yValues);
    const maxY = Math.max(...yValues);

    const graphWidth = maxX - minX + GRAPH.nodeWidth;
    const graphHeight = maxY - minY + GRAPH.nodeHeight;

    const viewportWidth = ui.viewport.clientWidth - margin * 2;
    const viewportHeight = ui.viewport.clientHeight - margin * 2;

    // Horizontal: center if it fits, otherwise show the start
    if (graphWidth * state.scale <= viewportWidth) {
      state.offsetX = margin - minX * state.scale + (viewportWidth - graphWidth * state.scale) / 2;
    } else {
      state.offsetX = margin - minX * state.scale;
    }

    // Vertical: always center
    state.offsetY = margin - minY * state.scale + (viewportHeight - graphHeight * state.scale) / 2;

    // 4. STORE IDEAL "HOME" POSITION
    state.idealOffsetX = state.offsetX;
    state.idealOffsetY = state.offsetY;

    // 5. APPLY & REDRAW
    setTransform();
    redrawConnections(positions);
  }

  function showLightbox(items, startIndex = 0) {
    if (!items || items.length === 0) return;
    let currentIndex = startIndex;

    const overlay = document.createElement('div');
    overlay.className = 'lightbox';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'close';
    closeBtn.innerHTML = '&times;';

    const img = document.createElement('img');
    const counter = document.createElement('div');
    counter.className = 'lightbox-counter';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'lightbox-nav prev';
    prevBtn.innerHTML = '&#10094;';

    const nextBtn = document.createElement('button');
    nextBtn.className = 'lightbox-nav next';
    nextBtn.innerHTML = '&#10095;';

    function updateContent() {
      const item = items[currentIndex];
      img.src = toFileSrc(item.path);
      img.alt = item.placeName || 'Photo preview';
      counter.innerText = `${currentIndex + 1} / ${items.length}`;

      // Hide nav buttons if only one image
      prevBtn.style.display = items.length > 1 ? 'block' : 'none';
      nextBtn.style.display = items.length > 1 ? 'block' : 'none';
    }

    function showPrev(e) {
      if (e) e.stopPropagation();
      currentIndex = (currentIndex - 1 + items.length) % items.length;
      updateContent();
    }

    function showNext(e) {
      if (e) e.stopPropagation();
      currentIndex = (currentIndex + 1) % items.length;
      updateContent();
    }

    function close() {
      overlay.remove();
      window.removeEventListener('keydown', handleKeys);
    }

    function handleKeys(e) {
      if (e.key === 'Escape' || e.key === 'Backspace') close();
      if (e.key === 'ArrowLeft') showPrev();
      if (e.key === 'ArrowRight') showNext();
    }

    closeBtn.onclick = close;
    prevBtn.onclick = showPrev;
    nextBtn.onclick = showNext;

    // Clicking left/right side of the overlay to navigate
    overlay.onclick = (e) => {
      if (e.target === overlay) {
        close();
        return;
      }
      const rect = overlay.getBoundingClientRect();
      if (e.clientX < rect.width / 3) {
        showPrev();
      } else if (e.clientX > (rect.width * 2) / 3) {
        showNext();
      }
    };

    updateContent();

    overlay.appendChild(closeBtn);
    overlay.appendChild(prevBtn);
    overlay.appendChild(nextBtn);
    overlay.appendChild(img);
    overlay.appendChild(counter);
    document.body.appendChild(overlay);
    window.addEventListener('keydown', handleKeys);
  }

  function getRelatedClusters(currentEventId) {
    const currentIndex = state.filteredClusters.findIndex((c) => c.id === currentEventId);
    if (currentIndex < 0) return [];
    const spread = 2;
    const related = [];
    for (let i = Math.max(0, currentIndex - spread); i <= Math.min(state.filteredClusters.length - 1, currentIndex + spread); i += 1) {
      if (i !== currentIndex) related.push(state.filteredClusters[i]);
    }
    return related;
  }

  function renderEmptyState(message) {
    ui.gallery.innerHTML = '';
    ui.connections.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'details';
    empty.innerText = message;
    ui.gallery.appendChild(empty);
  }

  function nodeCountLabel(cluster) {
    const videos = cluster.items.filter((item) => item.type === 'video').length;
    const images = cluster.items.length - videos;
    if (videos > 0 && images > 0) return `${cluster.items.length} items (${images} photos, ${videos} videos)`;
    if (videos > 0) return `${videos} video${videos > 1 ? 's' : ''}`;
    return `${images} photo${images > 1 ? 's' : ''}`;
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

  function setMapStyle(styleKey = 'voyager') {
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
      const label = trigger.querySelector('.dropdown-label');
      const item = ui.mapStyleSelect.querySelector(`.dropdown-item[data-value="${styleKey}"]`);
      if (item) {
        ui.mapStyleSelect.querySelectorAll('.dropdown-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        label.innerText = item.innerText;
      }
    }
  }

  function getMapClusterBounds(clusters) {
    const bounds = [];
    clusters.forEach((cluster) => {
      const fallback = cluster.items?.find((it) => typeof it.latitude === 'number' && typeof it.longitude === 'number');
      const lat = typeof cluster.centerLat === 'number' ? cluster.centerLat : fallback?.latitude;
      const lon = typeof cluster.centerLon === 'number' ? cluster.centerLon : fallback?.longitude;
      if (typeof lat === 'number' && typeof lon === 'number') {
        bounds.push([lat, lon]);
      }
    });
    return bounds;
  }

  function fitMapToClusters(clusters, { padding = [40, 40] } = {}) {
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
    if (ui.mapModeWrap) {
      ui.mapModeWrap.classList.toggle('hidden', !state.showMap);
    }
  }

  function updateMapModeMeta(clusters = state.filteredClusters) {
    if (!ui.mapModeMeta) return;
    const placeCount = clusters.filter((cluster) =>
      typeof cluster.centerLat === 'number' && typeof cluster.centerLon === 'number'
    ).length;
    const itemCount = clusters.reduce((sum, cluster) => sum + (cluster.items?.length || 0), 0);
    ui.mapModeMeta.innerText = `${placeCount} place${placeCount === 1 ? '' : 's'} · ${itemCount} item${itemCount === 1 ? '' : 's'}`;
  }

  function initMap() {
    if (!state.map) {
      state.map = L.map('map', {
        zoomControl: false,
        minZoom: MAP_MIN_ZOOM,
        worldCopyJump: false,
      }).setView([20, 0], MAP_MIN_ZOOM);
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles © Esri',
        maxZoom: 19,
      }).addTo(state.map);
      setMapStyle(state.currentMapStyle);
      L.control.zoom({ position: 'topright' }).addTo(state.map);
      // Axis-Constrained Interactions
      // 1. Horizontal Scroll-to-Pan (matching timeline scrub)
      const mapContainer = state.map.getContainer();
      mapContainer.addEventListener('wheel', (e) => {
        // If horizontal scroll is dominant, pan map horizontally
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          state.map.panBy([e.deltaX, 0], { animate: false });
          e.preventDefault();
          e.stopPropagation();
        }
      }, { capture: true, passive: false });

      // 2. Vertical-Only Dragging
      state.map.on('dragstart', () => {
        state.dragStartLng = state.map.getCenter().lng;
      });
      state.map.on('drag', () => {
        if (typeof state.dragStartLng === 'number') {
          const center = state.map.getCenter();
          // Force longitude to stay fixed during drag, allow latitude change
          state.map.setView([center.lat, state.dragStartLng], state.map.getZoom(), { animate: false });
        }
      });
      // Show Fit Memories button whenever user pans/zooms manually
      state.map.on('movestart', () => {
        if (state.showMap && !state.mapFitting && ui.fitMapBtn) {
          ui.fitMapBtn.classList.remove('hidden');
        }
      });
    }
    updateMapMarkers(state.filteredClusters);
  }

  function focusClusterFromMap(clusterId) {
    const cluster = state.filteredClusters.find((entry) => entry.id === clusterId);
    if (!cluster) return;

    state.openedFromMap = true;
    state.showMap = false;
    ui.mapPanel.classList.add('hidden');
    openCluster(clusterId);
  }

  function updateMapMarkers(clusters, { skipFitMap = false } = {}) {
    if (!state.map) return;
    state.mapMarkers.forEach((m) => state.map.removeLayer(m));
    state.mapMarkers = [];
    updateMapModeMeta(clusters);

    const wrappedLongitudes = Array.from({ length: 13 }, (_, index) => (index - 6) * 360);
    clusters.forEach((cluster) => {
      const fallback = cluster.items?.find((it) => typeof it.latitude === 'number' && typeof it.longitude === 'number');
      const lat = typeof cluster.centerLat === 'number' ? cluster.centerLat : fallback?.latitude;
      const lon = typeof cluster.centerLon === 'number' ? cluster.centerLon : fallback?.longitude;
      if (typeof lat === 'number' && typeof lon === 'number') {
        const formattedDate = new Date(cluster.startTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const itemCount = cluster.items.length;
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
        wrappedLongitudes.forEach((offset) => {
          const marker = L.marker([lat, lon + offset])
            .addTo(state.map)
            .bindPopup(popupHtml);
          state.mapMarkers.push(marker);
        });
      }
    });
    if (!skipFitMap && !state.mapSearchLocked) fitMapToClusters(clusters);
  }

  function setMapVisibility(show, { skipRender = false } = {}) {
    if (show) {
      state.inDetailsView = false;
    }
    state.showMap = show;
    ui.mapPanel.classList.toggle('hidden', !show);
    updateModeToolbar();
    updateNavActiveState();
    if (show) {
      state.mapSearchLocked = false;
      if (ui.fitMapBtn) ui.fitMapBtn.classList.add('hidden');
      initMap();
      setTimeout(() => {
        state.map.invalidateSize(false);
        updateMapMarkers(state.filteredClusters);
      }, 200);
    } else if (!skipRender) {
      renderClusters(state.filteredClusters);
    }
  }

  function renderClusters(clusters, options = {}) {
    state.filteredClusters = clusters;
    setGraphTransformEnabled(true);
    ui.gallery.innerHTML = '';

    // DYNAMIC WIDTH: fit the timeline, keep height compact
    const totalWidth = Math.max(1200, (clusters.length + 1) * GRAPH.gapX + 300);
    const totalHeight = 800;
    GRAPH.width = totalWidth;
    GRAPH.height = totalHeight;

    ui.gallery.style.width = `${GRAPH.width}px`;
    ui.gallery.style.height = `${GRAPH.height}px`;
    ui.connections.style.width = `${GRAPH.width}px`;
    ui.connections.style.height = `${GRAPH.height}px`;
    ui.connections.setAttribute('width', GRAPH.width);
    ui.connections.setAttribute('height', GRAPH.height);
    ui.connections.setAttribute('viewBox', `0 0 ${GRAPH.width} ${GRAPH.height}`);

    const positions = [];
    state.clusterElements.clear();

    clusters.forEach((cluster, index) => {
      const div = document.createElement('div');
      div.className = 'cluster';

      const x = GRAPH.startX + index * GRAPH.gapX;
      // Symmetric wave pattern: 0, 1, 2, 1, 0...
      // Using Math.abs((index % 4) - 2) gives 2, 1, 0, 1, 2...
      const lane = Math.abs((index % 4) - 2);
      const y = GRAPH.startY + lane * GRAPH.laneGap;

      positions.push({ id: cluster.id, x, y });
      div.style.left = `${x}px`;
      div.style.top = `${y}px`;

      div.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        openCluster(cluster.id);
      });

      div.addEventListener('mousedown', (e) => {
        if (state.inDetailsView) return;
        e.stopPropagation();
        const target = positions.find((p) => p.id === cluster.id);
        if (!target) return;
        state.draggedNodeId = cluster.id;
        state.nodeDragMoved = false;
        target.startX = target.x;
        target.startY = target.y;

        const rect = ui.viewport.getBoundingClientRect();
        const worldX = (e.clientX - rect.left - state.offsetX) / state.scale;
        const worldY = (e.clientY - rect.top - state.offsetY) / state.scale;
        target.dragOffsetX = worldX - target.x;
        target.dragOffsetY = worldY - target.y;
        ui.viewport.classList.add('dragging');
      });

      if (cluster.items[0].type === 'video') {
        const video = document.createElement('video');
        video.src = toFileSrc(cluster.items[0].path);
        video.width = 96;
        video.height = 96;
        video.muted = true;
        video.autoplay = true;
        video.loop = true;
        video.playsInline = true;
        div.appendChild(video);
      } else {
        const img = document.createElement('img');
        const displaySrc = cluster.items[0].thumbnailPath || cluster.items[0].path;
        img.src = toFileSrc(displaySrc);
        img.loading = 'lazy';
        img.onload = () => redrawConnections(state.lastPositions);
        div.appendChild(img);
      }

      const count = document.createElement('div');
      count.className = 'count';
      count.innerText = nodeCountLabel(cluster);

      const date = document.createElement('div');
      date.className = 'date';
      date.innerText = new Date(cluster.startTime).toDateString();

      div.appendChild(count);
      div.appendChild(date);

      if (cluster.placeName) {
        const chip = document.createElement('div');
        chip.className = 'place-chip';
        chip.innerText = cluster.placeName;
        div.appendChild(chip);
      }

      if (cluster.items[0].aiTags) {
        const tags = cluster.items[0].aiTags.split(',').slice(0, 2);
        tags.forEach(tag => {
          const tagEl = document.createElement('div');
          tagEl.className = 'ai-tag';
          tagEl.innerText = `✨ ${tag.trim()}`;
          div.appendChild(tagEl);
        });
      }

      ui.gallery.appendChild(div);
      state.clusterElements.set(cluster.id, div);
    });

    state.lastPositions = positions;
    redrawConnections(positions);
    centerOnPositions(positions);
    updateMapMarkers(clusters, options);
  }

  async function handleBackNavigation() {
    if (!state.inDetailsView) return;

    // Check if there's a specific back-action attribute, or use current flags
    const backBtn = document.querySelector('.back-nav');
    const action = backBtn ? backBtn.getAttribute('data-back-action') :
      (state.openedFromMap ? 'map' : (state.openedFromPeople ? 'people' : 'timeline'));

    console.log('[Nav] Back navigation triggered, action=', action);

    if (action === 'people') {
      resetViewportContext();
      ui.navPeople.click();
    } else if (action === 'map') {
      resetViewportContext();
      setMapVisibility(true);
      setTimeout(() => setTransform(), 0);
    } else {
      resetViewportContext();
      renderClusters(state.filteredClusters);
      setTransform();
    }
  }

  function openCluster(eventId) {
    const cluster = state.filteredClusters.find((c) => c.id === eventId);
    if (!cluster) return;

    state.inDetailsView = true;
    setGraphTransformEnabled(false);
    if (ui.floatingRecenterBtn) ui.floatingRecenterBtn.classList.add('hidden');

    ui.viewport.classList.add('scrollable-mode');
    ui.viewport.style.cursor = 'default';
    ui.connections.innerHTML = '';
    ui.gallery.innerHTML = '';
    ui.gallery.style.width = '100%';

    const wrapper = document.createElement('div');
    wrapper.className = 'details';

    const header = document.createElement('div');
    header.className = 'view-header';

    // Determine navigation destination
    const cameFromMap = state.openedFromMap;
    const cameFromPeople = state.openedFromPeople;
    const backDest = cameFromMap ? 'map' : cameFromPeople ? 'people' : 'timeline';
    const backLabel = cameFromMap ? 'Back to Map' : cameFromPeople ? 'Back to Identities' : 'Back to Timeline';

    const back = document.createElement('div');
    back.className = 'nav-item back-nav';
    back.style.width = 'fit-content';
    back.style.cursor = 'pointer';
    back.setAttribute('data-back-action', backDest);
    back.innerHTML = `<i>←</i> <span>${backLabel}</span>`;
    back.onclick = (e) => {
      e.stopPropagation();
      handleBackNavigation();
    };
    header.appendChild(back);
    wrapper.appendChild(header);

    const title = document.createElement('h2');
    title.innerText = formatDate(cluster.startTime);
    wrapper.appendChild(title);

    if (cluster.placeName) {
      const chip = document.createElement('div');
      chip.className = 'place-chip';
      chip.innerText = `🌍 ${cluster.placeName}`;
      wrapper.appendChild(chip);
    }

    if (cluster.items[0].aiTags) {
      const tagContainer = document.createElement('div');
      const tags = cluster.items[0].aiTags.split(',');
      tags.forEach(tag => {
        const tagEl = document.createElement('div');
        tagEl.className = 'ai-tag';
        tagEl.innerText = `✨ ${tag.trim()}`;
        tagContainer.appendChild(tagEl);
      });
      wrapper.appendChild(tagContainer);
    }

    const grid = document.createElement('div');
    grid.className = 'grid';
    cluster.items.forEach((item) => {
      if (item.type === 'video') {
        const video = document.createElement('video');
        video.src = toFileSrc(item.path);
        video.controls = true;
        video.preload = 'metadata';
        grid.appendChild(video);
      } else {
        const img = document.createElement('img');
        img.src = toFileSrc(item.path);
        img.loading = 'lazy';
        const imageItems = cluster.items.filter(it => it.type !== 'video');
        const imgIndex = imageItems.indexOf(item);
        img.onclick = () => showLightbox(imageItems, imgIndex);
        grid.appendChild(img);
      }
    });
    wrapper.appendChild(grid);

    const relatedTitle = document.createElement('h3');
    relatedTitle.innerText = 'Related Moments';
    wrapper.appendChild(relatedTitle);

    const related = getRelatedClusters(eventId);
    if (related.length === 0) {
      const none = document.createElement('p');
      none.innerText = 'No nearby moments available.';
      wrapper.appendChild(none);
    } else {
      related.forEach((rel) => {
        const item = document.createElement('div');
        item.className = 'nav-item';
        item.innerText = `${new Date(rel.startTime).toDateString()} (${rel.items.length})`;
        item.onclick = (e) => {
          e.stopPropagation();
          openCluster(rel.id);
        };
        wrapper.appendChild(item);
      });
    }

    ui.gallery.appendChild(wrapper);

    // Auto-focus on grid (images) after a short delay
    setTimeout(() => {
      grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 250);

    // Update sidebar state
    updateNavActiveState();
  }

  function renderSearchResults(items) {
    state.inDetailsView = true;
    setGraphTransformEnabled(false);
    ui.viewport.style.overflow = 'auto';
    ui.viewport.style.cursor = 'default';
    ui.connections.innerHTML = '';
    ui.gallery.innerHTML = '';
    ui.gallery.style.position = 'relative';
    ui.gallery.style.width = '100%';
    ui.gallery.style.height = '100%';

    const wrapper = document.createElement('div');
    wrapper.className = 'details';

    const back = document.createElement('button');
    back.className = 'back-btn';
    back.innerText = '← Back to Graph';
    back.onclick = async () => {
      await handleBackNavigation();
    };
    wrapper.appendChild(back);

    const title = document.createElement('h2');
    title.innerText = `Search Results for "${state.searchQuery}"`;
    wrapper.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'grid';

    items.forEach((item) => {
      if (item.type === 'video') {
        const video = document.createElement('video');
        video.src = toFileSrc(item.path);
        video.controls = true;
        video.preload = 'metadata';
        grid.appendChild(video);
      } else {
        const img = document.createElement('img');
        const displaySrc = item.thumbnailPath || item.path;
        img.src = toFileSrc(displaySrc);
        img.loading = 'lazy';
        const imageItems = items.filter(it => it.type !== 'video');
        const imgIndex = imageItems.indexOf(item);
        img.onclick = () => showLightbox(imageItems, imgIndex);
        grid.appendChild(img);
      }
    });

    wrapper.appendChild(grid);
    ui.gallery.appendChild(wrapper);
  }

  function updateFilterUI() {
    ui.filterPortraitBtn.classList.toggle('active', state.faceFilter === 'portrait');
    ui.filterGroupBtn.classList.toggle('active', state.faceFilter === 'group');
  }

  ui.filterPortraitBtn.addEventListener('click', () => {
    state.faceFilter = state.faceFilter === 'portrait' ? null : 'portrait';
    updateFilterUI();
    applyFilters();
  });

  ui.filterGroupBtn.addEventListener('click', () => {
    state.faceFilter = state.faceFilter === 'group' ? null : 'group';
    updateFilterUI();
    applyFilters();
  });

  function applyFilters() {
    if (state.inDetailsView && !state.searchQuery) return;

    let baseClusters = state.allClusters.map(c => {
      // Identity Filter
      if (state.personFilter && c.id !== `person-${state.personFilter}`) return null;

      if (!state.faceFilter) return c;
      const filteredItems = c.items.filter(it => {
        const lowerTags = (it.aiTags || "").toLowerCase();

        // Hierarchy of human indicators
        const hasIdentity = it.personNames && it.personNames.trim().length > 0;
        const humanTerms = ['person', 'man', 'woman', 'human', 'face', 'portrait', 'lady', 'gentleman', 'boy', 'girl', 'child', 'adult', 'people', 'smile', 'selfie'];
        const hasHumanTerm = humanTerms.some(k => lowerTags.includes(k));

        // Scalable clash detection (exclude if non-human categories dominate)
        const clashTerms = ['car', 'boat', 'vehicle', 'automobile', 'nature', 'landscape', 'tree', 'flower', 'building', 'scenery', 'architecture', 'bird', 'animal', 'robot', 'statue', 'toy', 'watercraft'];
        const hasClash = !hasIdentity && clashTerms.some(k => lowerTags.includes(k));

        const hasPerson = hasIdentity || hasHumanTerm || lowerTags.includes('person');
        const isVerifiedPerson = hasPerson && !hasClash;

        if (state.faceFilter === 'portrait') return it.faceCount === 1 && isVerifiedPerson;
        if (state.faceFilter === 'group') return it.faceCount >= 2 && isVerifiedPerson;
        return true;
      });
      return { ...c, items: filteredItems };
    }).filter(c => c && c.items.length > 0);

    if (state.searchQuery) {
      const terms = state.searchQuery.toLowerCase().split(' ').filter(t => t.trim().length > 0);
      let matchingItems = [];

      baseClusters.forEach(c => {
        c.items.forEach(it => {
          const searchSource = [
            it.placeName,
            c.placeName,
            new Date(c.startTime).toDateString(),
            it.aiTags,
            it.personNames, // Add recognized people to search
            it.path
          ].filter(Boolean).join(' ').toLowerCase();

          // Require all space-separated search terms to match somewhere in the item's metadata
          const isMatch = terms.every(term => searchSource.includes(term));

          if (isMatch) {
            matchingItems.push(it);
          }
        });
      });

      if (matchingItems.length > 0 || (state.semanticMatches && state.semanticMatches.length > 0)) {
        const combined = [...matchingItems, ...(state.semanticMatches || [])];
        const uniqueItems = Array.from(new Set(combined));

        ui.timeLabel.innerText = `${uniqueItems.length} matching items (${(state.semanticMatches || []).length} semantic)`;
        renderSearchResults(uniqueItems);
      } else {
        ui.timeLabel.innerText = 'No matches found';
        renderEmptyState('No matches found.');
      }
      return;
    }

    const timelineVal = parseInt(ui.slider.value, 10);
    const count = Math.ceil((timelineVal / 100) * baseClusters.length);
    let filtered = baseClusters.slice(0, count);

    if (filtered.length > 0) {
      if (state.groupBy === 'date') {
        const first = filtered[0].startTime;
        const last = filtered[filtered.length - 1].startTime;
        ui.timeLabel.innerText = `${new Date(first).toLocaleDateString()} — ${new Date(last).toLocaleDateString()}`;
      } else {
        ui.timeLabel.innerText = `${filtered.length} ${state.groupBy === 'location' ? 'Places' : 'Subjects'} visible`;
      }
    } else {
      ui.timeLabel.innerText = 'No clusters available';
    }

    const isSearching = state.showMap && document.activeElement === ui.searchInput;
    renderClusters(filtered, { skipFitMap: isSearching });
  }

  function updateNavActiveState() {
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

    // Highlight based on effective mode/origin
    if (state.showMap || (state.inDetailsView && state.openedFromMap)) {
      ui.navMap.classList.add('active');
    } else if ((state.groupBy === 'person' && state.inDetailsView) || state.openedFromPeople) {
      ui.navPeople.classList.add('active');
    } else {
      ui.navTimeline.classList.add('active');
    }

    if (state.inDetailsView) {
      setGraphTransformEnabled(false);
    } else {
      setGraphTransformEnabled(true);
    }
  }

  async function refreshViewMode() {
    updateNavActiveState();
    ui.status.innerText = 'Reclustering memories...';
    ui.status.style.opacity = '1';
    try {
      const data = await window.api.invoke('get-events', { groupBy: state.groupBy });
      state.allClusters = data;
      state.filteredClusters = [...data];
      state.clusterElements.clear(); // Important! Clear old elements
      state.lastPositions = []; // To force redraw from left side
      applyFilters(); // re-evaluates faceFilter and search bounds
      ui.status.innerText = `Loaded ${data.length} clusters.`;
      setTimeout(() => ui.status.style.opacity = '0', 2000);
    } catch (err) {
      ui.status.innerText = `Error: ${err.message}`;
    }
  }

  function updateLibraryDirtyUI() {
    if (ui.refreshLibraryBtn) {
      ui.refreshLibraryBtn.classList.toggle('needs-refresh', state.libraryDirty);
      ui.refreshLibraryBtn.title = state.libraryDirty ? 'New or changed files detected' : 'Refresh Library';
    }
    if (ui.manageFoldersBtn) {
      ui.manageFoldersBtn.classList.toggle('has-badge', state.libraryDirty);
      ui.manageFoldersBtn.title = state.libraryDirty ? 'Settings (new or changed files detected)' : 'Settings';
    }
  }

  async function switchGroupBy(nextGroupBy) {
    if (state.groupBy === nextGroupBy) return;
    state.groupBy = nextGroupBy;
    state.personFilter = null;

    // Sync visual dropdown if it exists
    if (ui.groupBySelect) {
      const trigger = ui.groupBySelect.querySelector('.dropdown-trigger');
      const label = trigger.querySelector('.dropdown-label');
      const item = ui.groupBySelect.querySelector(`.dropdown-item[data-value="${nextGroupBy}"]`);
      if (item && label) {
        ui.groupBySelect.querySelectorAll('.dropdown-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        label.innerText = item.innerText;
      }
    }

    await refreshViewMode();
  }

  async function focusClusterFromPeople(personId) {
    state.inDetailsView = false;
    setMapVisibility(false, { skipRender: true });
    await switchGroupBy('person');
    state.personFilter = personId;
    applyFilters();
    // Set flag AFTER async work so refreshViewMode can't wipe it
    state.openedFromPeople = true;
    openCluster(`person-${personId}`);
  }

  // Remove old event listener on select

  // Listen for progress updates from the main process
  if (window.api && window.api.on) {
    window.api.on('indexing-progress', (event, data) => {
      ui.status.innerText = `✨ ${data.message} (${data.percentage}%)`;
    });
  }

  if (window.api && window.api.on) {
    window.api.on('library-refresh-complete', async (event, data) => {
      state.libraryDirty = false;
      updateLibraryDirtyUI();
      if (data?.reason !== 'manual' && !state.inDetailsView) {
        await refreshViewMode();
      }
    });

    window.api.on('library-change-detected', () => {
      state.libraryDirty = true;
      updateLibraryDirtyUI();
    });

    window.api.on('library-refresh-error', (event, data) => {
      ui.status.innerText = `Refresh failed: ${data.message}`;
      ui.status.style.opacity = '1';
    });

    window.api.on('face-indexing-started', (event, data) => {
      ui.status.innerText = `Analyzing faces: 0 / ${data.total}`;
      ui.status.style.opacity = '1';
    });

    window.api.on('face-indexing-progress', (event, data) => {
      ui.status.innerText = `Analyzing faces: ${data.current} / ${data.total} (${data.percentage}%)`;
      ui.status.style.opacity = '1';
    });

    window.api.on('face-indexing-complete', async (event, data) => {
      const seconds = typeof data?.durationMs === 'number' ? (data.durationMs / 1000).toFixed(1) : null;
      ui.status.innerText = seconds ? `Face indexing complete in ${seconds}s` : 'Face indexing complete';
      ui.status.style.opacity = '1';
      setTimeout(() => {
        if (ui.status.innerText.startsWith('Face indexing complete')) {
          ui.status.innerText = '';
          ui.status.style.opacity = '0';
        }
      }, 1800);
      if (!state.inDetailsView) {
        await refreshViewMode();
      }
    });

    window.api.on('visual-indexing-started', (event, data) => {
      ui.status.innerText = `Analyzing : 0 / ${data.total}`;
      ui.status.style.opacity = '1';
    });

    window.api.on('visual-indexing-progress', (event, data) => {
      ui.status.innerText = `Analyzing : ${data.current} / ${data.total} (${data.percentage}%)`;
      ui.status.style.opacity = '1';
    });

    window.api.on('visual-indexing-complete', async (event, data) => {
      const seconds = typeof data?.durationMs === 'number' ? (data.durationMs / 1000).toFixed(1) : null;
      ui.status.innerText = seconds ? `Analysis complete in ${seconds}s` : 'Analysis complete';
      ui.status.style.opacity = '1';
      setTimeout(() => {
        if (ui.status.innerText.startsWith('Analysis complete')) {
          ui.status.innerText = '';
          ui.status.style.opacity = '0';
        }
      }, 1800);
      if (!state.inDetailsView) {
        await refreshViewMode();
      }
    });

    window.api.on('semantic-indexing-started', (event, data) => {
      ui.status.innerText = `Indexing search vectors: 0 / ${data.total}`;
      ui.status.style.opacity = '1';
    });

    window.api.on('semantic-indexing-progress', (event, data) => {
      ui.status.innerText = `Indexing search vectors: ${data.current} / ${data.total} (${data.percentage}%)`;
      ui.status.style.opacity = '1';
    });

    window.api.on('semantic-indexing-complete', (event, data) => {
      const seconds = typeof data?.durationMs === 'number' ? (data.durationMs / 1000).toFixed(1) : null;
      ui.status.innerText = seconds ? `Search indexing complete in ${seconds}s` : 'Search indexing complete';
      ui.status.style.opacity = '1';
      setTimeout(() => {
        if (ui.status.innerText.startsWith('Search indexing complete')) {
          ui.status.innerText = '';
          ui.status.style.opacity = '0';
        }
      }, 1800);
    });
  }

  async function loadImages() {
    try {
      ui.status.innerText = 'Loading your memories...';
      ui.status.style.opacity = '1';
      state.allClusters = await window.api.invoke('read-images', { groupBy: state.groupBy });
      const indexDebug = await window.api.getIndexDebug();
      state.libraryDirty = Boolean(indexDebug?.libraryDirty);
      updateLibraryDirtyUI();
      if (!Array.isArray(state.allClusters) || state.allClusters.length === 0) {
        if (!indexDebug?.latestRun) {
          await refreshLibrary();
          return;
        }
        ui.status.innerText = 'No supported images found in your Pictures folder.';
        if (indexDebug?.latestRun) {
          ui.debug.innerText = `Scanned ${indexDebug.latestRun.scannedCount} files in ${indexDebug.latestRun.roots.length} roots`;
        }
        renderEmptyState('Add some JPG/PNG/WEBP images to your Pictures folder and restart.');
      } else {
        if (state.libraryDirty) {
          ui.status.innerText = 'New or changed files detected. Refresh Library to update.';
          ui.status.style.opacity = '1';
        } else {
          ui.status.innerText = '';
          ui.status.style.opacity = '0';
        }
      }

      if (indexDebug) {
        // Debug info hidden for cleaner UI
        ui.debug.style.opacity = '0';
      }

      state.filteredClusters = [...state.allClusters];
      ui.slider.oninput = () => applyFilters();
      applyFilters();
    } catch (error) {
      ui.status.innerText = 'Unable to load photos.';
      renderEmptyState(`Error: ${error.message || 'Unknown error'}`);
    }
  }

  async function refreshLibrary() {
    try {
      ui.status.innerText = '✨ Discovering your memories...';
      ui.status.style.opacity = '1';
      state.allClusters = await window.api.invoke('refresh-library', { groupBy: state.groupBy });
      const indexDebug = await window.api.getIndexDebug();
      state.libraryDirty = Boolean(indexDebug?.libraryDirty);
      updateLibraryDirtyUI();

      if (!Array.isArray(state.allClusters) || state.allClusters.length === 0) {
        ui.status.innerText = 'No supported images found in your Pictures folder.';
        if (indexDebug?.latestRun) {
          ui.debug.innerText = `Scanned ${indexDebug.latestRun.scannedCount} files in ${indexDebug.latestRun.roots.length} roots`;
        }
        renderEmptyState('Add some JPG/PNG/WEBP images to your Pictures folder and restart.');
      } else {
        ui.status.innerText = '';
        ui.status.style.opacity = '0';
      }

      if (indexDebug) {
        ui.debug.style.opacity = '0';
      }

      state.filteredClusters = [...state.allClusters];
      ui.slider.oninput = () => applyFilters();
      applyFilters();
    } catch (error) {
      ui.status.innerText = 'Unable to refresh library.';
      renderEmptyState(`Error: ${error.message || 'Unknown error'}`);
    }
  }

  function bindInteractions() {
    document.addEventListener('click', (event) => {
      const popupTrigger = event.target.closest('.map-popup-link');
      if (popupTrigger) {
        event.preventDefault();
        focusClusterFromMap(popupTrigger.dataset.clusterId);
        return;
      }
    });


    ui.viewport.addEventListener('mousedown', (e) => {
      if (state.inDetailsView) return;
      state.isDraggingViewport = true;
      state.dragMoved = false;
      state.dragStartClientX = e.clientX;
      state.dragStartClientY = e.clientY;
      state.startOffsetX = state.offsetX;
      state.startOffsetY = state.offsetY;
      ui.viewport.classList.add('dragging');
    });

    window.addEventListener('mousemove', (e) => {
      if (state.draggedNodeId) {
        const target = state.lastPositions.find((p) => p.id === state.draggedNodeId);
        if (!target) return;

        const rect = ui.viewport.getBoundingClientRect();
        const worldX = (e.clientX - rect.left - state.offsetX) / state.scale;
        const worldY = (e.clientY - rect.top - state.offsetY) / state.scale;
        target.x = Math.max(20, Math.min(worldX - target.dragOffsetX, GRAPH.width - 160));
        target.y = Math.max(20, Math.min(worldY - target.dragOffsetY, GRAPH.height - 170));

        if (Math.abs(target.x - target.startX) > 2 || Math.abs(target.y - target.startY) > 2) {
          state.nodeDragMoved = true;
        }

        const el = state.clusterElements.get(state.draggedNodeId);
        if (el) {
          el.style.left = `${target.x}px`;
          el.style.top = `${target.y}px`;
        }
        redrawConnections(state.lastPositions);
        return;
      }

      if (!state.isDraggingViewport) return;
      const dx = e.clientX - state.dragStartClientX;
      const dy = e.clientY - state.dragStartClientY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) state.dragMoved = true;
      state.offsetX = state.startOffsetX + dx;
      state.offsetY = state.startOffsetY + dy;
      setTransform();
    });

    window.addEventListener('mouseup', () => {
      if (state.draggedNodeId) {
        if (state.nodeDragMoved) state.suppressClickUntil = Date.now() + 180;
        state.draggedNodeId = null;
        state.nodeDragMoved = false;
        ui.viewport.classList.remove('dragging');
        return;
      }
      if (state.dragMoved) state.suppressClickUntil = Date.now() + 180;
      state.isDraggingViewport = false;
      ui.viewport.classList.remove('dragging');
    });

    window.addEventListener('keydown', async (e) => {
      if (e.key === 'Backspace') {
        // Prevent navigation if user is typing in an input or textarea
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
          return;
        }
        // Don't navigate if lightbox is open (lightbox handles its own Backspace)
        if (document.querySelector('.lightbox')) {
          return;
        }
        e.preventDefault();
        await handleBackNavigation();
      }

      if (e.key === 'Escape') {
        if (state.draggedNodeId) {
          state.draggedNodeId = null;
          state.nodeDragMoved = false;
          ui.viewport.classList.remove('dragging');
          redrawConnections(state.lastPositions);
        }
        // Close modals if they are visible
        if (ui.settingsModal && !ui.settingsModal.classList.contains('hidden')) {
          ui.settingsModal.classList.add('hidden');
        }
        if (ui.renameModal && !ui.renameModal.classList.contains('hidden')) {
          ui.renameModal.classList.add('hidden');
        }
      }
    });

    ui.viewport.addEventListener('wheel', (e) => {
      if (state.inDetailsView) return;

      // Vertical scroll = Always Zoom
      // Horizontal scroll (deltaX) = Always Pan (Timeline Scrub)
      const isZoom = e.ctrlKey || e.metaKey || (Math.abs(e.deltaY) > Math.abs(e.deltaX));

      if (isZoom) {
        e.preventDefault();
        const zoomSpeed = 0.0015;
        const delta = -e.deltaY;
        const oldScale = state.scale;

        // Dynamic limits
        state.scale = Math.max(0.12, Math.min(1.0, state.scale + delta * zoomSpeed));

        const rect = ui.viewport.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Gravity: gently anchor toward the content center
        const worldCenterX = GRAPH.width / 2;
        const worldCenterY = GRAPH.height / 2;

        if (state.scale < 0.7) {
          const targetOffsetX = (rect.width / 2) - (worldCenterX * state.scale);
          const targetOffsetY = (rect.height / 2) - (worldCenterY * state.scale);
          state.offsetX = state.offsetX * 0.85 + targetOffsetX * 0.15;
          state.offsetY = state.offsetY * 0.85 + targetOffsetY * 0.15;
        } else {
          state.offsetX = mouseX - (mouseX - state.offsetX) * (state.scale / oldScale);
          state.offsetY = mouseY - (mouseY - state.offsetY) * (state.scale / oldScale);
        }

        clampOffsets();
        setTransform();
      } else {
        // HORIZONTAL SCRUBBING
        state.offsetX -= e.deltaX * 1.5;
        clampOffsets();
        setTransform();
        e.preventDefault();
      }
    }, { passive: false });

    function clampOffsets() {
      const vw = ui.viewport.clientWidth;
      const vh = ui.viewport.clientHeight;

      // Keep at least 200px of content visible at all times
      const minX = -(GRAPH.width * state.scale - 200);
      const maxX = vw - 200;
      const minY = -(GRAPH.height * state.scale - 200);
      const maxY = vh - 200;

      state.offsetX = Math.max(minX, Math.min(maxX, state.offsetX));
      state.offsetY = Math.max(minY, Math.min(maxY, state.offsetY));
    }

    if (ui.floatingRecenterBtn) {
      ui.floatingRecenterBtn.addEventListener('click', () => {
        centerOnPositions(state.lastPositions);

        if (ui.floatingRecenterBtn) {
          ui.floatingRecenterBtn.classList.add('hidden');
        }
      });
    }

    ui.clearCacheActionBtn.addEventListener('click', async () => {
      if (confirm('This will wipe all indexed data and restart the app. Continue?')) {
        await window.api.invoke('clear-cache');
      }
    });

    ui.navTimeline.onclick = async () => {
      const token = ++state.navigationToken;
      resetViewportContext();
      setMapVisibility(false, { skipRender: true });
      await switchGroupBy('date');
      if (token !== state.navigationToken) return;
      if (state.groupBy === 'date') {
        refreshViewMode();
      }
    };

    ui.navPeople.onclick = async () => {
      ++state.navigationToken;
      await openPeopleGallery();
    };

    function setupCustomDropdown(el, onChange) {
      if (!el) return;
      const trigger = el.querySelector('.dropdown-trigger');
      const labelEl = trigger.querySelector('.dropdown-label');
      const menu = el.querySelector('.dropdown-menu');
      const items = el.querySelectorAll('.dropdown-item');

      trigger.onclick = (e) => {
        e.stopPropagation();
        const isOpen = menu.classList.contains('show');
        // Close all other dropdowns
        document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
        document.querySelectorAll('.dropdown-trigger').forEach(t => t.classList.remove('open'));

        if (!isOpen) {
          menu.classList.add('show');
          trigger.classList.add('open');
        }
      };

      items.forEach(item => {
        item.onclick = (e) => {
          e.stopPropagation();
          const val = item.getAttribute('data-value');

          // VISUAL SYNC
          items.forEach(i => i.classList.remove('active'));
          item.classList.add('active');
          if (labelEl) labelEl.innerText = item.innerText;

          onChange(val);
          menu.classList.remove('show');
          trigger.classList.remove('open');
        };
      });
    }

    setupCustomDropdown(ui.groupBySelect, (val) => {
      switchGroupBy(val);
    });

    setupCustomDropdown(ui.mapStyleSelect, (val) => {
      setMapStyle(val);
    });

    // Close on outside click
    document.addEventListener('click', () => {
      document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
      document.querySelectorAll('.dropdown-trigger').forEach(t => t.classList.remove('open'));
    });

    ui.navMap.onclick = async () => {
      const token = ++state.navigationToken;
      const willShow = !state.showMap;
      if (willShow) {
        resetViewportContext();
        await switchGroupBy('location');
        if (token !== state.navigationToken) return;
      } else {
        resetViewportContext();
        setMapVisibility(false, { skipRender: true });
        await switchGroupBy('date');
        if (token !== state.navigationToken) return;
        if (state.groupBy === 'date') {
          refreshViewMode();
        }
        return;
      }
      setMapVisibility(willShow);
    };

    if (ui.fitMapBtn) {
      ui.fitMapBtn.classList.add('hidden');
      ui.fitMapBtn.onclick = () => {
        state.mapSearchLocked = false;
        fitMapToClusters(state.filteredClusters);

        if (ui.fitMapBtn) {
          ui.fitMapBtn.classList.add('hidden');
        }
      };
    }

    if (ui.mapStyleSelect) {
      ui.mapStyleSelect.value = state.currentMapStyle;
      ui.mapStyleSelect.onchange = (e) => {
        setMapStyle(e.target.value);
      };
    }

    ui.manageFoldersBtn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        const settings = await window.api.invoke('get-index-roots');
        state.indexRoots = Array.isArray(settings) ? settings : settings.roots;
        ui.includeVideosCheckbox.checked = settings.includeVideos !== false;
        renderRootsList();
        ui.settingsModal.classList.remove('hidden');
      } catch (err) {
        console.error('Failed to open folders:', err);
        alert('Could not open folder settings.');
      }
      try {
        const settings = await window.api.invoke('get-index-roots');
        state.indexRoots = Array.isArray(settings) ? settings : settings.roots;
        ui.includeVideosCheckbox.checked = settings.includeVideos !== false;
        renderRootsList();
        ui.settingsModal.classList.remove('hidden');
      } catch (err) {
        console.error('Failed to open folders:', err);
        alert('Could not open folder settings.');
      }
    };

    ui.closeSettingsBtn.onclick = () => ui.settingsModal.classList.add('hidden');
    ui.addFolderBtn.onclick = async () => {
      const path = await window.api.invoke('select-folder');
      if (path && !state.indexRoots.includes(path)) {
        state.indexRoots.push(path);
        renderRootsList();
      }
    };

    ui.saveSettingsBtn.onclick = async () => {
      await window.api.invoke('set-index-roots', {
        roots: state.indexRoots,
        includeVideos: ui.includeVideosCheckbox.checked
      });
      ui.settingsModal.classList.add('hidden');
      refreshLibrary();
    };

    function renderRootsList() {
      ui.rootsList.innerHTML = '';
      state.indexRoots.forEach((root, idx) => {
        const item = document.createElement('div');
        item.className = 'root-item';
        item.innerHTML = `
          <span>${root}</span>
          <button class="remove-btn" title="Remove">✕</button>
        `;
        item.querySelector('.remove-btn').onclick = () => {
          state.indexRoots.splice(idx, 1);
          renderRootsList();
        };
        ui.rootsList.appendChild(item);
      });
    }

    let semanticSearchTimeout = null;

    ui.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        ui.searchInput.blur();
        return;
      }
      if (e.key === 'Enter' && state.showMap && state.searchQuery.trim().length > 0) {
        e.preventDefault();
        const query = state.searchQuery.toLowerCase().trim();
        const match = state.filteredClusters.find(c =>
          c.placeName && c.placeName.toLowerCase().includes(query)
        );

        if (match) {
          const fallback = match.items?.find((it) => typeof it.latitude === 'number' && typeof it.longitude === 'number');
          const lat = typeof match.centerLat === 'number' ? match.centerLat : fallback?.latitude;
          const lon = typeof match.centerLon === 'number' ? match.centerLon : fallback?.longitude;
          if (typeof lat === 'number' && typeof lon === 'number') {
            state.mapSearchLocked = true;
            state.map.flyTo([lat, lon], 12, { animate: true, duration: 1.5 });
            const markerLat = lat.toFixed(5);
            const markerLon = lon.toFixed(5);
            setTimeout(() => {
              const marker = state.mapMarkers.find(m => {
                return m.getLatLng().lat.toFixed(5) === markerLat &&
                  m.getLatLng().lng.toFixed(5) === markerLon;
              });
              if (marker) {
                marker.openPopup();
              }
            }, 1600);
          }
        } else {
          ui.status.innerText = `Location "${state.searchQuery}" not found on map`;
          ui.status.style.opacity = '1';
          setTimeout(() => {
            if (ui.status.innerText.includes("not found")) {
              ui.status.innerText = '';
              ui.status.style.opacity = '0';
            }
          }, 3000);
        }
      }
    });

    ui.searchInput.oninput = (e) => {
      state.searchQuery = e.target.value;
      if (state.searchQuery.length > 0) {
        ui.clearSearchBtn.style.display = 'flex';
      } else {
        ui.clearSearchBtn.style.display = 'none';
        state.semanticMatches = [];
      }
      applyFilters();

      clearTimeout(semanticSearchTimeout);
      if (state.searchQuery.length >= 3) {
        semanticSearchTimeout = setTimeout(async () => {
          ui.status.innerText = '✨ Analyzing visual concepts...';
          ui.status.style.opacity = '1';
          try {
            const matchedPaths = await window.api.invoke('search-semantic', state.searchQuery);
            if (!matchedPaths || matchedPaths.length === 0) return;
            const items = [];
            state.allClusters.forEach(c => {
              c.items.forEach(it => {
                if (matchedPaths.includes(it.path)) items.push(it);
              });
            });
            state.semanticMatches = items;
            applyFilters();
          } catch (err) {
            console.error(err);
          } finally {
            ui.status.style.opacity = '0';
          }
        }, 600);
      }
    };

    if (ui.clearSearchBtn) {
      ui.clearSearchBtn.onclick = () => {
        ui.searchInput.value = '';
        state.searchQuery = '';
        state.mapSearchLocked = false;
        ui.clearSearchBtn.style.display = 'none';
        applyFilters();
      };
    }

    async function openPeopleGallery() {
      const token = state.navigationToken;
      await switchGroupBy('person');
      if (token !== state.navigationToken) return;

      state.inDetailsView = true;
      setMapVisibility(false, { skipRender: true });
      setGraphTransformEnabled(false);
      if (ui.floatingRecenterBtn) ui.floatingRecenterBtn.classList.add('hidden');

      ui.viewport.classList.add('scrollable-mode');
      ui.viewport.style.cursor = 'default';
      ui.connections.innerHTML = '';
      ui.gallery.innerHTML = '';
      ui.gallery.style.position = 'relative';
      ui.gallery.style.width = '100%';
      ui.gallery.style.height = 'auto'; // Allow growth
      ui.gallery.style.minHeight = '100%'; // Ensure background coverage

      const wrapper = document.createElement('div');
      wrapper.className = 'details';

      const header = document.createElement('div');
      header.className = 'view-header';

      const title = document.createElement('h2');
      title.innerText = 'Recognized Identities';
      header.appendChild(title);
      wrapper.appendChild(header);

      const people = await window.api.invoke('get-people');
      const grid = document.createElement('div');
      grid.className = 'grid';

      people.forEach(person => {
        const item = document.createElement('div');
        item.className = 'person-card';

        const img = document.createElement('img');
        img.src = toFileSrc(person.thumbnail_path);

        const name = document.createElement('div');
        name.className = 'person-name';
        name.innerText = person.name;
        name.style.cursor = 'pointer';
        name.title = 'Click to rename';

        const openRename = async (e) => {
          e.stopPropagation();
          ui.renameInput.value = person.name;
          ui.renameModal.classList.remove('hidden');
          ui.renameInput.focus();

          ui.saveRenameBtn.onclick = async () => {
            const newName = ui.renameInput.value.trim();
            if (newName && newName !== person.name) {
              await window.api.invoke('rename-person', { id: person.id, name: newName });
              ui.renameModal.classList.add('hidden');
              ui.navPeople.click(); // Refresh gallery
              refreshViewMode(); // Refresh main graph
            } else {
              ui.renameModal.classList.add('hidden');
            }
          };

          ui.closeRenameBtn.onclick = () => ui.renameModal.classList.add('hidden');
          ui.renameInput.onkeydown = (ev) => {
            if (ev.key === 'Enter') ui.saveRenameBtn.click();
            if (ev.key === 'Escape') ui.renameModal.classList.add('hidden');
          };
        };

        name.onclick = openRename;

        const rename = document.createElement('button');
        rename.className = 'rename-btn';
        rename.innerText = '✎';
        rename.onclick = openRename;

        item.onclick = async () => {
          await focusClusterFromPeople(person.id);
        };

        item.appendChild(img);
        item.appendChild(name);
        item.appendChild(rename);
        grid.appendChild(item);
      });

      wrapper.appendChild(grid);
      ui.gallery.appendChild(wrapper);
      ui.viewport.scrollTop = 0;
      updateNavActiveState();
    };

    ui.refreshLibraryBtn.addEventListener('click', async () => {
      ui.refreshLibraryBtn.disabled = true;
      ui.refreshLibraryBtn.innerText = 'Reloading...';
      try {
        await refreshLibrary();
      } finally {
        ui.refreshLibraryBtn.disabled = false;
        ui.refreshLibraryBtn.innerText = '🔄 Refresh Library';
      }
    });

    window.addEventListener('resize', () => {
      if (state.showMap && state.map) {
        state.map.invalidateSize(false);
        updateMapMarkers(state.filteredClusters);
        return;
      }
      if (!state.inDetailsView) renderClusters(state.filteredClusters);
    });
  }

  updateModeToolbar();
  bindUserActivitySignals();
  bindInteractions();
  loadImages();
}());
