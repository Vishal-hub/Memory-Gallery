import { state, ui } from './state.js';
import { toFileSrc, renderEmptyState, getDisplayPath, showIndexingHint, renderGridIncrementally } from './utils.js';
import { renderClusters, setGraphTransformEnabled, handleBackNavigation } from './graph.js';
import { showLightbox } from './lightbox.js';

let _hydrationRunId = 0;
const _clusterHydrationPromises = new Map();
let _lastTimelineRenderSignature = '';
let _lastSearchRenderSignature = '';
let _lastEmptyStateSignature = '';

function buildClusterRenderSignature(clusters = []) {
    return (Array.isArray(clusters) ? clusters : []).map((cluster) => {
        const cover = cluster?.coverItem || cluster?.items?.[0] || {};
        return [
            cluster?.id || '',
            cluster?.items?.length || 0,
            cluster?.startTime || 0,
            cluster?.endTime || 0,
            cluster?.placeName || '',
            cover?.path || '',
            cover?.thumbnailPath || '',
            cover?.aiTags || '',
            cover?.personClass || '',
        ].join('|');
    }).join('||');
}

function buildItemRenderSignature(items = []) {
    return (Array.isArray(items) ? items : []).map((item) => [
        item?.path || item?.id || '',
        item?.thumbnailPath || '',
        item?.aiTags || '',
        item?.personClass || '',
    ].join('|')).join('||');
}

function isSummaryBackedGroup(groupBy) {
    return groupBy === 'date' || groupBy === 'location' || groupBy === 'tag';
}

function replaceClusterItems(clusterId, items) {
    const upgrade = (cluster) => cluster.id === clusterId
        ? { ...cluster, items, itemCount: items.length, hasFullItems: true }
        : cluster;
    state.allClusters = state.allClusters.map(upgrade);
    state.filteredClusters = state.filteredClusters.map(upgrade);
}

async function hydrateClusterItems(clusterId) {
    if (!clusterId) return [];
    if (_clusterHydrationPromises.has(clusterId)) {
        return _clusterHydrationPromises.get(clusterId);
    }
    const promise = window.api.invoke('get-cluster-items', { clusterId })
        .then((items) => {
            const nextItems = Array.isArray(items) ? items : [];
            replaceClusterItems(clusterId, nextItems);
            return nextItems;
        })
        .finally(() => {
            _clusterHydrationPromises.delete(clusterId);
        });
    _clusterHydrationPromises.set(clusterId, promise);
    return promise;
}

export async function progressivelyHydrateClusters(options = {}) {
    if (state.clusterDataModeByGroup[state.groupBy] === 'full') return;
    if (!isSummaryBackedGroup(state.groupBy)) return;

    const { visibleOnly = false, onBatch = null, batchSize = 6 } = options;
    const runId = ++_hydrationRunId;
    const sliderVal = ui.slider ? parseInt(ui.slider.value, 10) : 100;
    const visibleCount = Math.ceil((sliderVal / 100) * state.allClusters.length);
    const sourceClusters = visibleOnly ? state.allClusters.slice(0, visibleCount) : state.allClusters;
    const targets = sourceClusters.filter((cluster) => !cluster.hasFullItems);

    for (let index = 0; index < targets.length; index += batchSize) {
        if (runId !== _hydrationRunId) return;
        const batch = targets.slice(index, index + batchSize);
        await Promise.all(batch.map((cluster) => hydrateClusterItems(cluster.id)));
        if (runId !== _hydrationRunId) return;
        if (typeof onBatch === 'function') {
            onBatch();
        }
    }

    if (!state.allClusters.some((cluster) => !cluster.hasFullItems)) {
        state.clusterDataModeByGroup[state.groupBy] = 'full';
    }
}

export function updateFilterUI() {
    ui.filterPortraitBtn.classList.toggle('active', state.faceFilter === 'portrait');
    ui.filterGroupBtn.classList.toggle('active', state.faceFilter === 'group');
}

export function renderSearchResults(items) {
    _lastTimelineRenderSignature = '';
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

    const back = document.createElement('div');
    back.className = 'nav-item back-nav';
    back.style.width = 'fit-content';
    back.style.cursor = 'pointer';
    back.innerHTML = `<i>←</i> <span>Back to Graph</span>`;
    back.onclick = async (e) => {
        e.stopPropagation();
        await handleBackNavigation();
    };
    wrapper.appendChild(back);

    const title = document.createElement('h2');
    title.innerText = `Search Results for "${state.searchQuery}"`;
    wrapper.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'grid';

    const imageItems = items.filter(it => it.type !== 'video');
    const imageIndexByPath = new Map(imageItems.map((item, index) => [item.path, index]));
    renderGridIncrementally({
        items,
        grid,
        batchSize: 40,
        createNode: (item) => {
            if (item.type === 'video') {
                const video = document.createElement('video');
                video.src = toFileSrc(item.path);
                if (item.thumbnailPath) {
                    video.poster = toFileSrc(item.thumbnailPath);
                }
                video.controls = true;
                video.preload = 'none';
                return video;
            }

            const img = document.createElement('img');
            img.src = toFileSrc(getDisplayPath(item));
            img.loading = 'lazy';
            const imgIndex = imageIndexByPath.get(item.path) ?? 0;
            img.onclick = () => showLightbox(imageItems, imgIndex);
            return img;
        },
    });

    wrapper.appendChild(grid);
    ui.gallery.appendChild(wrapper);
    _lastSearchRenderSignature = buildItemRenderSignature(items);
    _lastEmptyStateSignature = '';
}

export function applyFilters(forceRender = false) {
    if (state.inDetailsView && !state.searchQuery) {
        if (state.treeViewActive || state.openedFromPeople || state.openedFromTree || state.openedFromMap) {
            return;
        }
        handleBackNavigation();
        return;
    }

    let baseClusters = state.allClusters.map(c => {
        if (state.personFilter && c.id !== `person-${state.personFilter}`) return null;

        if (!state.faceFilter) return c;
        const filteredItems = c.items.filter(it => {
            const pc = it.personClass || 'none';
            if (state.faceFilter === 'portrait') return pc === 'portrait';
            if (state.faceFilter === 'group') return pc === 'group';
            return true;
        });
        return { ...c, items: filteredItems };
    }).filter(c => c && c.items.length > 0);

    if (state.searchQuery) {
        if (!state.indexingComplete.vectors) {
            showIndexingHint('Still indexing — search results will improve in a moment');
        }
        const terms = state.searchQuery.toLowerCase().split(' ').filter(t => t.trim().length > 0);
        let matchingItems = [];

        baseClusters.forEach(c => {
            c.items.forEach(it => {
                const searchSource = [
                    it.placeName,
                    c.placeName,
                    new Date(c.startTime).toDateString(),
                    it.aiTags,
                    it.personNames,
                    it.path
                ].filter(Boolean).join(' ').toLowerCase();

                const isMatch = terms.every(term => searchSource.includes(term));
                if (isMatch) {
                    matchingItems.push(it);
                }
            });
        });

        if (matchingItems.length > 0 || (state.semanticMatches && state.semanticMatches.length > 0)) {
            const combined = [...matchingItems, ...(state.semanticMatches || [])];
            const seen = new Set();
            const uniqueItems = combined.filter(it => {
                const key = it.path || it.id;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            ui.timeLabel.innerText = `${uniqueItems.length} matching items (${(state.semanticMatches || []).length} semantic)`;
            const nextSearchSignature = buildItemRenderSignature(uniqueItems);
            if (forceRender || nextSearchSignature !== _lastSearchRenderSignature) {
                renderSearchResults(uniqueItems);
            }
        } else {
            ui.timeLabel.innerText = 'No matches found';
            const emptySignature = `search-empty|${state.searchQuery}`;
            if (forceRender || _lastEmptyStateSignature !== emptySignature) {
                renderEmptyState('No matches found.');
                _lastEmptyStateSignature = emptySignature;
                _lastSearchRenderSignature = '';
                _lastTimelineRenderSignature = '';
            }
        }
        return;
    }

    const timelineVal = ui.slider ? parseInt(ui.slider.value, 10) : 100;
    const count = Math.ceil((timelineVal / 100) * baseClusters.length);
    let filtered = baseClusters.slice(0, count);
    state.filteredClusters = filtered;

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
        if (state.allClusters && state.allClusters.length > 0) {
            const emptySignature = `timeline-empty|${state.groupBy}|${timelineVal}|${state.faceFilter || ''}|${state.personFilter || ''}`;
            if (forceRender || _lastEmptyStateSignature !== emptySignature) {
                renderEmptyState('No memories found in the selected time range. Move the slider to see more.');
                _lastEmptyStateSignature = emptySignature;
                _lastTimelineRenderSignature = '';
                _lastSearchRenderSignature = '';
            }
            return;
        }
    }

    const isSearching = state.showMap && document.activeElement === ui.searchInput;
    const nextTimelineSignature = buildClusterRenderSignature(filtered);
    if (!forceRender && _lastTimelineRenderSignature === nextTimelineSignature && !state.inDetailsView) {
        return;
    }
    _lastTimelineRenderSignature = nextTimelineSignature;
    _lastSearchRenderSignature = '';
    _lastEmptyStateSignature = '';
    renderClusters(filtered, { skipFitMap: isSearching });
}

export function bindSearchListeners() {
    ui.filterPortraitBtn.addEventListener('click', async () => {
        if (state.clusterDataModeByGroup[state.groupBy] !== 'full') {
            await progressivelyHydrateClusters({
                visibleOnly: true,
                onBatch: () => {
                    if (state.faceFilter === 'portrait') {
                        applyFilters();
                    }
                },
            });
        }
        state.faceFilter = state.faceFilter === 'portrait' ? null : 'portrait';
        updateFilterUI();
        if (state.faceFilter && (!state.indexingComplete.visual || !state.indexingComplete.faces)) {
            showIndexingHint('Still analyzing photos — filter results will improve shortly');
        }
        applyFilters();
    });

    ui.filterGroupBtn.addEventListener('click', async () => {
        if (state.clusterDataModeByGroup[state.groupBy] !== 'full') {
            await progressivelyHydrateClusters({
                visibleOnly: true,
                onBatch: () => {
                    if (state.faceFilter === 'group') {
                        applyFilters();
                    }
                },
            });
        }
        state.faceFilter = state.faceFilter === 'group' ? null : 'group';
        updateFilterUI();
        if (state.faceFilter && (!state.indexingComplete.visual || !state.indexingComplete.faces)) {
            showIndexingHint('Still analyzing photos — filter results will improve shortly');
        }
        applyFilters();
    });
}
