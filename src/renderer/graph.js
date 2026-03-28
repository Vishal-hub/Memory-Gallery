import { GRAPH, state, ui } from './state.js';
import { toFileSrc, formatDate, nodeCountLabel, getDisplayPath, getFullSizePath, renderEmptyState } from './utils.js';
import { showLightbox } from './lightbox.js';
import { updateMapMarkers, setMapVisibility } from './map.js';

function seededRandom(seed) {
    let s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
}

function pulseY(t) {
    const TWO_PI = Math.PI * 2;
    return Math.sin(t * TWO_PI) * 0.55
        + Math.sin(t * TWO_PI * 2 + 0.8) * 0.30
        + Math.sin(t * TWO_PI * 3 + 2.0) * 0.15;
}

function computeAllPositions(count) {
    const vpH = ui.viewport ? ui.viewport.clientHeight : 600;
    const canvasH = Math.max(vpH - 80, 520);
    GRAPH.height = canvasH;

    const padY = 60;
    const padX = 100;
    const midY = canvasH / 2;
    const amplitude = (canvasH / 2) - padY - GRAPH.nodeHeight / 2;

    const totalW = Math.max(1200, (count + 1) * GRAPH.gapX + 300);
    GRAPH.width = totalW;

    const cycleLen = Math.max(3.5, count * 0.45);
    const placed = [];

    for (let i = 0; i < count; i++) {
        const r3 = seededRandom(i * 3571 + 53);

        const x = padX + i * GRAPH.gapX;
        const t = i / Math.max(1, count - 1) * cycleLen;
        const beat = pulseY(t);
        const y = midY - beat * amplitude - GRAPH.nodeHeight / 2;

        const scale = 0.94 + Math.abs(beat) * 0.12 + r3 * 0.04;
        placed.push({ x, y, scale });
    }

    return placed;
}

function computeNodePosition(i, count) {
    if (!computeNodePosition._cache || computeNodePosition._cacheCount !== count) {
        computeNodePosition._cache = computeAllPositions(count);
        computeNodePosition._cacheCount = count;
    }
    return computeNodePosition._cache[i] || { x: 0, y: 0, scale: 1 };
}

export function setTransform() {
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

export function resetViewportContext() {
    state.inDetailsView = false;
    state.openedFromMap = false;
    state.openedFromPeople = false;
    state.openedFromTree = false;
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

    const centerX = GRAPH.width / 2;
    const centerY = GRAPH.height / 2;
    const count = state.lastPositions.length;
    const circleRadius = Math.min(GRAPH.height / 2 - 80, Math.max(250, count * 18));

    const morphedPositions = state.lastPositions.map((pos, i) => {
        const base = computeNodePosition(i, count);

        const angle = (i / count) * Math.PI * 2;
        const circleX = centerX + circleRadius * Math.cos(angle);
        const circleY = centerY + circleRadius * Math.sin(angle);

        let x = base.x;
        let y = base.y;

        if (morphFactor > 0) {
            x = base.x * (1 - morphFactor) + circleX * morphFactor;
            y = base.y * (1 - morphFactor) + circleY * morphFactor;
        }

        const el = state.clusterElements.get(pos.id);
        if (el) {
            el.style.left = `${x}px`;
            el.style.top = `${y}px`;
        }

        return { ...pos, x, y };
    });

    redrawConnections(morphedPositions, morphFactor);
}

export function redrawConnections(positions, morphFactor = 0) {
    const defs = ui.connections.querySelector('defs');
    if (!positions || positions.length < 2) {
        ui.connections.innerHTML = '';
        if (defs) ui.connections.appendChild(defs);
        return;
    }

    ui.connections.innerHTML = '';
    if (defs) ui.connections.appendChild(defs);

    if (morphFactor >= 0.8) return;

    const fragment = document.createDocumentFragment();
    const fade = Math.max(0, 1 - morphFactor * 1.5);

    const nodeRects = positions.map(pos => {
        const el = state.clusterElements.get(pos.id);
        const w = el ? el.offsetWidth : GRAPH.nodeWidth;
        const h = el ? el.offsetHeight : GRAPH.nodeHeight;
        return { x: pos.x, y: pos.y, w, h, cx: pos.x + w / 2, cy: pos.y + h / 2 };
    });

    for (let i = 0; i < positions.length - 1; i++) {
        const a = nodeRects[i];
        const b = nodeRects[i + 1];

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', a.x + a.w);
        line.setAttribute('y1', a.cy);
        line.setAttribute('x2', b.x);
        line.setAttribute('y2', b.cy);
        line.setAttribute('class', 'constellation-line');
        line.style.opacity = fade * 0.45;
        fragment.appendChild(line);
    }

    const starCount = Math.max(40, Math.round(GRAPH.width * GRAPH.height / 12000));
    for (let s = 0; s < starCount; s++) {
        const sx = seededRandom(s * 7919 + 11) * GRAPH.width;
        const sy = seededRandom(s * 6271 + 37) * GRAPH.height;

        let blocked = false;
        for (const r of nodeRects) {
            if (sx > r.x - 10 && sx < r.x + r.w + 10 && sy > r.y - 10 && sy < r.y + r.h + 10) {
                blocked = true;
                break;
            }
        }
        if (blocked) continue;

        const r3 = seededRandom(s * 3571 + 53);
        const size = 0.6 + r3 * 2;
        const bright = r3 > 0.8;

        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', sx);
        dot.setAttribute('cy', sy);
        dot.setAttribute('r', size);
        dot.setAttribute('class', bright ? 'star-dot star-dot-bright' : 'star-dot');
        dot.style.animationDelay = `${seededRandom(s * 4919 + 71) * -8}s`;
        dot.style.opacity = fade;
        fragment.appendChild(dot);
    }

    ui.connections.appendChild(fragment);
}

export function setGraphTransformEnabled(enabled) {
    ui.connections.style.display = enabled ? 'block' : 'none';
    if (enabled) {
        setTransform();
    } else {
        ui.gallery.style.transform = 'none';
        ui.connections.style.transform = 'none';
    }
}

export function centerOnPositions(positions) {
    if (!positions || positions.length === 0) return;

    state.scale = 1.0;
    state.idealScale = 1;

    positions.forEach((pos, i) => {
        const p = computeNodePosition(i, positions.length);
        pos.x = p.x;
        pos.y = p.y;
        const el = state.clusterElements.get(pos.id);
        if (el) {
            el.style.left = `${p.x}px`;
            el.style.top = `${p.y}px`;
            el.style.setProperty('--node-scale', p.scale);
        }
    });

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

    if (graphWidth * state.scale <= viewportWidth) {
        state.offsetX = margin - minX * state.scale + (viewportWidth - graphWidth * state.scale) / 2;
    } else {
        state.offsetX = margin - minX * state.scale;
    }

    state.offsetY = margin - minY * state.scale + (viewportHeight - graphHeight * state.scale) / 2;

    state.idealOffsetX = state.offsetX;
    state.idealOffsetY = state.offsetY;

    setTransform();
    redrawConnections(positions);
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

let _renderGen = 0;

export function renderClusters(clusters, options = {}) {
    const gen = ++_renderGen;
    state.filteredClusters = clusters;
    setGraphTransformEnabled(true);
    ui.gallery.innerHTML = '';

    if (clusters.length === 0) {
        renderEmptyState('No photos found. Open Settings to add folders with JPG/PNG/WEBP images.');
        return;
    }

    computeNodePosition._cache = null;
    computeNodePosition._cacheCount = 0;
    computeNodePosition(0, clusters.length);

    ui.gallery.style.width = `${GRAPH.width}px`;
    ui.gallery.style.height = `${GRAPH.height}px`;
    ui.connections.style.width = `${GRAPH.width}px`;
    ui.connections.style.height = `${GRAPH.height}px`;
    ui.connections.setAttribute('width', GRAPH.width);
    ui.connections.setAttribute('height', GRAPH.height);
    ui.connections.setAttribute('viewBox', `0 0 ${GRAPH.width} ${GRAPH.height}`);

    if (!ui.connections.querySelector('#connGrad')) {
        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
        grad.id = 'connGrad';
        grad.setAttribute('gradientUnits', 'userSpaceOnUse');
        grad.setAttribute('x1', '0');
        grad.setAttribute('y1', '0');
        grad.setAttribute('x2', String(GRAPH.width));
        grad.setAttribute('y2', '0');
        const stop1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
        stop1.setAttribute('offset', '0%');
        stop1.setAttribute('stop-color', '#a78bfa');
        stop1.setAttribute('stop-opacity', '0.6');
        const stop2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
        stop2.setAttribute('offset', '50%');
        stop2.setAttribute('stop-color', '#818cf8');
        stop2.setAttribute('stop-opacity', '0.45');
        const stop3 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
        stop3.setAttribute('offset', '100%');
        stop3.setAttribute('stop-color', '#38bdf8');
        stop3.setAttribute('stop-opacity', '0.6');
        grad.appendChild(stop1);
        grad.appendChild(stop2);
        grad.appendChild(stop3);
        defs.appendChild(grad);
        ui.connections.appendChild(defs);
    } else {
        const grad = ui.connections.querySelector('#connGrad');
        grad.setAttribute('x2', String(GRAPH.width));
    }

    const positions = [];
    state.clusterElements.clear();

    clusters.forEach((cluster, index) => {
        if (!cluster.items || cluster.items.length === 0) return;

        const div = document.createElement('div');
        div.className = 'cluster';
        div.setAttribute('role', 'button');
        div.setAttribute('tabindex', '0');
        div.setAttribute('aria-label', `${cluster.placeName || cluster.label || ''} — ${nodeCountLabel(cluster)}`);

        const pos = computeNodePosition(index, clusters.length);

        positions.push({ id: cluster.id, x: pos.x, y: pos.y });
        div.style.left = `${pos.x}px`;
        div.style.top = `${pos.y}px`;
        div.style.setProperty('--node-scale', pos.scale);

        const perNode = 0.55;
        const cycleDur = Math.max(5, clusters.length * perNode + 2);
        div.style.setProperty('--wave-total', `${cycleDur.toFixed(2)}s`);
        div.style.setProperty('--wave-delay', `${(index * perNode).toFixed(2)}s`);

        div.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            openCluster(cluster.id);
        });

        div.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                openCluster(cluster.id);
            }
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

        const ring = document.createElement('div');
        ring.className = 'img-ring';

        const displayPath = getDisplayPath(cluster.items[0]);
        const hasThumbnail = Boolean(displayPath);

        if (!hasThumbnail) {
            ring.classList.add('shimmer');
        }

        if (cluster.items[0].type === 'video') {
            const video = document.createElement('video');
            video.src = toFileSrc(cluster.items[0].path);
            video.width = 108;
            video.height = 108;
            video.muted = true;
            video.autoplay = true;
            video.loop = true;
            video.playsInline = true;
            ring.appendChild(video);
        } else {
            const img = document.createElement('img');
            if (hasThumbnail) {
                img.src = toFileSrc(displayPath);
            }
            img.loading = 'lazy';
            img.onload = () => {
                ring.classList.remove('shimmer');
                if (gen === _renderGen) redrawConnections(state.lastPositions);
            };
            img.onerror = () => { ring.classList.add('shimmer'); };
            ring.appendChild(img);
        }
        div.appendChild(ring);

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

export function openCluster(eventId) {
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

    const cameFromMap = state.openedFromMap;
    const cameFromPeople = state.openedFromPeople;
    const cameFromTree = state.openedFromTree;
    const backDest = cameFromMap ? 'map' : cameFromTree ? 'tree' : cameFromPeople ? 'people' : 'timeline';
    const backLabel = cameFromMap ? 'Back to Map' : cameFromTree ? 'Back to Family Tree' : cameFromPeople ? 'Back to Identities' : 'Back to Timeline';

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
        chip.innerText = `● ${cluster.placeName}`;
        wrapper.appendChild(chip);
    }

    if (cluster.items[0].aiTags) {
        const aiRow = document.createElement('div');
        aiRow.className = 'detail-tags-row';
        const tags = cluster.items[0].aiTags.split(',');
        tags.forEach(tag => {
            const tagEl = document.createElement('div');
            tagEl.className = 'ai-tag';
            tagEl.innerText = `✨ ${tag.trim()}`;
            aiRow.appendChild(tagEl);
        });
        wrapper.appendChild(aiRow);
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
            img.src = toFileSrc(getFullSizePath(item));
            img.loading = 'lazy';
            img.setAttribute('tabindex', '0');
            img.setAttribute('role', 'button');
            img.alt = item.tags || item.name || 'Photo';
            const imageItems = cluster.items.filter(it => it.type !== 'video');
            const imgIndex = imageItems.indexOf(item);
            img.onclick = () => showLightbox(imageItems, imgIndex);
            img.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    showLightbox(imageItems, imgIndex);
                }
            });
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
            item.setAttribute('role', 'button');
            item.setAttribute('tabindex', '0');
            item.innerText = `${new Date(rel.startTime).toDateString()} (${rel.items.length})`;
            const activate = (e) => {
                e.stopPropagation();
                openCluster(rel.id);
            };
            item.onclick = activate;
            item.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    activate(e);
                }
            });
            wrapper.appendChild(item);
        });
    }

    ui.gallery.appendChild(wrapper);

    setTimeout(() => {
        grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 250);

    updateNavActiveState();
}

export function updateNavActiveState() {
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

    if (state.treeViewActive || state.openedFromTree) {
        ui.navFamilyTree.classList.add('active');
    } else if (state.showMap || (state.inDetailsView && state.openedFromMap)) {
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

export async function focusPersonCluster(personId, switchGroupByFn, { source, beforeFn } = {}) {
    if (typeof beforeFn === 'function') beforeFn();
    state.inDetailsView = false;
    setMapVisibility(false, { skipRender: true });
    await switchGroupByFn('person');
    state.personFilter = personId;
    const { applyFilters } = await import('./search.js');
    applyFilters();
    if (source === 'tree') state.openedFromTree = true;
    else if (source === 'people') state.openedFromPeople = true;
    openCluster(`person-${personId}`);
}

export async function handleBackNavigation() {
    if (!state.inDetailsView) return;

    const backBtn = document.querySelector('.back-nav');
    const action = backBtn ? backBtn.getAttribute('data-back-action') :
        (state.openedFromMap ? 'map' : (state.openedFromTree ? 'tree' : (state.openedFromPeople ? 'people' : 'timeline')));

    if (action === 'tree') {
        resetViewportContext();
        ui.navFamilyTree.click();
    } else if (action === 'people') {
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