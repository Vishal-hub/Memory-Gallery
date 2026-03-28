import { state, ui } from './state.js';
import { toFileSrc, renderEmptyState, getDisplayPath, showIndexingHint } from './utils.js';
import { renderClusters, setGraphTransformEnabled, handleBackNavigation } from './graph.js';
import { showLightbox } from './lightbox.js';

export function updateFilterUI() {
    ui.filterPortraitBtn.classList.toggle('active', state.faceFilter === 'portrait');
    ui.filterGroupBtn.classList.toggle('active', state.faceFilter === 'group');
}

export function renderSearchResults(items) {
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

    items.forEach((item) => {
        if (item.type === 'video') {
            const video = document.createElement('video');
            video.src = toFileSrc(item.path);
            video.controls = true;
            video.preload = 'metadata';
            grid.appendChild(video);
        } else {
            const img = document.createElement('img');
            img.src = toFileSrc(getDisplayPath(item));
            img.loading = 'lazy';
            const imgIndex = imageItems.indexOf(item);
            img.onclick = () => showLightbox(imageItems, imgIndex);
            grid.appendChild(img);
        }
    });

    wrapper.appendChild(grid);
    ui.gallery.appendChild(wrapper);
}

export function applyFilters() {
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
            renderSearchResults(uniqueItems);
        } else {
            ui.timeLabel.innerText = 'No matches found';
            renderEmptyState('No matches found.');
        }
        return;
    }

    const timelineVal = ui.slider ? parseInt(ui.slider.value, 10) : 100;
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
        if (state.allClusters && state.allClusters.length > 0) {
            renderEmptyState('No memories found in the selected time range. Move the slider to see more.');
            return;
        }
    }

    const isSearching = state.showMap && document.activeElement === ui.searchInput;
    renderClusters(filtered, { skipFitMap: isSearching });
}

export function bindSearchListeners() {
    ui.filterPortraitBtn.addEventListener('click', () => {
        state.faceFilter = state.faceFilter === 'portrait' ? null : 'portrait';
        updateFilterUI();
        if (state.faceFilter && (!state.indexingComplete.visual || !state.indexingComplete.faces)) {
            showIndexingHint('Still analyzing photos — filter results will improve shortly');
        }
        applyFilters();
    });

    ui.filterGroupBtn.addEventListener('click', () => {
        state.faceFilter = state.faceFilter === 'group' ? null : 'group';
        updateFilterUI();
        if (state.faceFilter && (!state.indexingComplete.visual || !state.indexingComplete.faces)) {
            showIndexingHint('Still analyzing photos — filter results will improve shortly');
        }
        applyFilters();
    });
}
