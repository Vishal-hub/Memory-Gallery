import { GRAPH, state, ui } from './state.js';
import { renderEmptyState } from './utils.js';
import {
  setTransform,
  resetViewportContext,
  redrawConnections,
  scheduleConnectionsRedraw,
  centerOnPositions,
  renderClusters,
  relayoutClustersForViewport,
  openCluster,
  updateNavActiveState,
  handleBackNavigation,
} from './graph.js';
import {
  setMapStyle,
  fitMapToClusters,
  setMapVisibility,
  updateMapMarkers,
  updateModeToolbar,
  focusClusterFromMap,
  registerGraphCallbacks,
} from './map.js';
import { openPeopleGallery, hidePeopleToolbar, resortPeopleGallery, refreshPeopleGallery } from './people.js';
import { openFamilyTree, closeFamilyTree, handleTreeKeydown } from './family-tree.js';
import { applyFilters, bindSearchListeners, progressivelyHydrateClusters } from './search.js';
import {
  setLoadingSubtitle,
  setLoadingDetail,
  setLoadingProgress,
  setLoadingPhase,
  markPhaseDone,
  dismissLoading,
  isLoadingVisible,
} from './loading.js';

let _rafFilterId = 0;
let _lastRendererInteractionAt = Date.now();
function debouncedApplyFilters() {
  cancelAnimationFrame(_rafFilterId);
  _rafFilterId = requestAnimationFrame(() => applyFilters());
}

let _refreshDebounceTimer = 0;
function debouncedRefreshViewMode() {
  clearTimeout(_refreshDebounceTimer);
  _refreshDebounceTimer = setTimeout(() => refreshViewMode(), 300);
}

let _statusHideTimer = 0;
const _statusProgressState = new Map();
function setStatusMessage(message, options = {}) {
  if (!ui.status) return;
  const visible = options.visible !== false;
  const nextText = message || '';
  const nextOpacity = visible && nextText ? '1' : '0';

  if (ui.status.innerText !== nextText) {
    ui.status.innerText = nextText;
  }
  if (ui.status.style.opacity !== nextOpacity) {
    ui.status.style.opacity = nextOpacity;
  }

  clearTimeout(_statusHideTimer);
  if (options.autoHideMs && nextText) {
    const expectedText = nextText;
    _statusHideTimer = setTimeout(() => {
      if (ui.status.innerText === expectedText) {
        setStatusMessage('', { visible: false });
      }
    }, options.autoHideMs);
  }
}

function clearStatusMessage(options = {}) {
  if (!ui.status) return;
  const expectedPrefixes = Array.isArray(options.prefixes) ? options.prefixes.filter(Boolean) : null;
  if (expectedPrefixes && expectedPrefixes.length > 0) {
    const current = ui.status.innerText || '';
    if (!expectedPrefixes.some((prefix) => current.startsWith(prefix))) {
      return;
    }
  }
  setStatusMessage('', { visible: false });
}

function setProgressStatus(progressKey, message, percentage, options = {}) {
  if (!ui.status) return;
  const now = Date.now();
  const minIntervalMs = options.minIntervalMs ?? 180;
  const minPercentageStep = options.minPercentageStep ?? 2;
  const progressValue = Number.isFinite(percentage) ? percentage : 0;
  const previous = _statusProgressState.get(progressKey);

  if (previous) {
    const elapsed = now - previous.updatedAt;
    const delta = Math.abs(progressValue - previous.percentage);
    const sameMessage = previous.message === message;
    const force = options.force === true || progressValue >= 100;
    if (!force && sameMessage && elapsed < minIntervalMs && delta < minPercentageStep) {
      return;
    }
  }

  _statusProgressState.set(progressKey, {
    percentage: progressValue,
    updatedAt: now,
    message,
  });
  setStatusMessage(message, { visible: true });
}

let _cacheSyncDebounceTimer = 0;
let _pendingCacheSync = false;
let _pendingForcedCacheSync = false;
let _activeCacheSyncPromise = null;
let _summaryPageLoadToken = 0;
let _resizeRelayoutTimer = 0;
function clusterSummarySignature(cluster) {
  const cover = cluster?.coverItem || cluster?.items?.[0] || {};
  return [
    cluster?.id || '',
    Number.isFinite(cluster?.itemCount) ? cluster.itemCount : (cluster?.items?.length || 0),
    cluster?.startTime || 0,
    cluster?.endTime || 0,
    cluster?.placeName || '',
    cover?.path || '',
    cover?.thumbnailPath || '',
    cover?.aiTags || '',
    cover?.personClass || '',
  ].join('|');
}

function haveClustersChanged(prevClusters, nextClusters, options = {}) {
  const allowCurrentSuperset = options.allowCurrentSuperset === true;
  if (!Array.isArray(prevClusters) || !Array.isArray(nextClusters)) return true;
  if (!allowCurrentSuperset && prevClusters.length !== nextClusters.length) return true;
  if (allowCurrentSuperset && prevClusters.length < nextClusters.length) return true;
  const compareLength = allowCurrentSuperset ? nextClusters.length : prevClusters.length;
  for (let i = 0; i < compareLength; i += 1) {
    if (clusterSummarySignature(prevClusters[i]) !== clusterSummarySignature(nextClusters[i])) {
      return true;
    }
  }
  return false;
}

function getClusterPageState(groupBy) {
  if (!state.clusterPageStateByGroup[groupBy]) {
    state.clusterPageStateByGroup[groupBy] = {
      nextCursor: 0,
      hasMore: false,
      loading: false,
      token: 0,
      timer: 0,
    };
  }
  return state.clusterPageStateByGroup[groupBy];
}

function setClusterPageState(groupBy, page) {
  const pageState = getClusterPageState(groupBy);
  pageState.nextCursor = page?.nextCursor || 0;
  pageState.hasMore = Boolean(page?.hasMore);
  return pageState;
}

async function fetchInitialSummaryClusters(groupBy) {
  const page = await window.api.invoke('get-cluster-page', { groupBy, cursor: 0, limit: 200 });
  const clusters = Array.isArray(page?.clusters) ? page.clusters : [];
  setClusterPageState(groupBy, page);
  return clusters;
}

function canProgressivelyLoadSummary(groupBy) {
  return state.groupBy === groupBy
    && !state.inDetailsView
    && !state.peopleViewActive
    && !state.treeViewActive
    && document.visibilityState === 'visible';
}

function scheduleRemainingSummaryLoad(groupBy, delayMs = 900) {
  if (!isSummaryBackedGroup(groupBy)) return;
  const pageState = getClusterPageState(groupBy);
  if (!pageState.hasMore || pageState.loading || pageState.timer) return;

  const token = ++_summaryPageLoadToken;
  pageState.token = token;
  pageState.timer = setTimeout(async () => {
    pageState.timer = 0;
    if (pageState.token !== token) return;
    if (!canProgressivelyLoadSummary(groupBy) || Date.now() - _lastRendererInteractionAt < 1200) {
      scheduleRemainingSummaryLoad(groupBy, 1200);
      return;
    }

    pageState.loading = true;
    try {
      let didAppend = false;
      while (pageState.hasMore && pageState.token === token) {
        if (!canProgressivelyLoadSummary(groupBy) || Date.now() - _lastRendererInteractionAt < 1200) {
          break;
        }
        const page = await window.api.invoke('get-cluster-page', {
          groupBy,
          cursor: pageState.nextCursor,
          limit: 200,
        });
        const nextClusters = Array.isArray(page?.clusters) ? page.clusters : [];
        setClusterPageState(groupBy, page);
        if (nextClusters.length > 0 && state.clusterDataModeByGroup[groupBy] === 'summary') {
          const existingById = new Set((state.allClusters || []).map((cluster) => cluster?.id).filter(Boolean));
          const appended = nextClusters.filter((cluster) => !existingById.has(cluster?.id));
          if (appended.length > 0) {
            state.allClusters = [...state.allClusters, ...appended];
            didAppend = true;
          }
        }
        if (pageState.hasMore) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }

      if (didAppend && state.groupBy === groupBy && !state.inDetailsView) {
        state.filteredClusters = [...state.allClusters];
        if (ui.slider) ui.slider.oninput = debouncedApplyFilters;
        applyFilters();
      }
    } catch (error) {
      console.error('Progressive summary load failed:', error);
    } finally {
      pageState.loading = false;
      if (pageState.hasMore && pageState.token === token) {
        scheduleRemainingSummaryLoad(groupBy, 1200);
      }
    }
  }, delayMs);
}

async function syncCachedGroupData(groupBy = state.groupBy, options = {}) {
  const force = options.force === true;
  const wantsFullItems = state.clusterDataModeByGroup[groupBy] === 'full' || !isSummaryBackedGroup(groupBy);
  const nextClusters = wantsFullItems
    ? await fetchClustersForGroup(groupBy, { fullItems: true })
    : await fetchInitialSummaryClusters(groupBy);
  if (!Array.isArray(nextClusters)) return false;

  const unchanged = !force && (wantsFullItems
    ? !haveClustersChanged(state.allClusters, nextClusters)
    : !haveClustersChanged(state.allClusters, nextClusters, { allowCurrentSuperset: true }));
  if (unchanged) {
    if (!wantsFullItems) {
      scheduleRemainingSummaryLoad(groupBy, 1200);
    }
    return false;
  }

  state.allClusters = nextClusters;
  state.clusterDataModeByGroup[groupBy] = wantsFullItems ? 'full' : 'summary';

  if (state.groupBy === groupBy && !state.inDetailsView) {
    state.filteredClusters = [...nextClusters];
    if (ui.slider) ui.slider.oninput = debouncedApplyFilters;
    applyFilters();
  }

  if (!wantsFullItems) {
    scheduleRemainingSummaryLoad(groupBy, 1200);
  }

  return true;
}

function canSyncCurrentViewCache() {
  return !state.inDetailsView
    && !state.peopleViewActive
    && !state.treeViewActive
    && document.visibilityState === 'visible';
}

function debouncedSyncCurrentGroupCache(delayMs = 300) {
  clearTimeout(_cacheSyncDebounceTimer);
  _cacheSyncDebounceTimer = setTimeout(() => {
    const force = _pendingForcedCacheSync;
    if (Date.now() - _lastRendererInteractionAt < 1200) {
      if (force) _pendingForcedCacheSync = true;
      debouncedSyncCurrentGroupCache(1200);
      return;
    }
    if (!canSyncCurrentViewCache()) {
      _pendingCacheSync = true;
      if (force) _pendingForcedCacheSync = true;
      return;
    }
    if (_activeCacheSyncPromise) {
      _pendingCacheSync = true;
      if (force) _pendingForcedCacheSync = true;
      return;
    }
    _pendingCacheSync = false;
    _pendingForcedCacheSync = false;
    _activeCacheSyncPromise = syncCachedGroupData(state.groupBy, { force })
      .catch((error) => {
        console.error('Cached group sync failed:', error);
      })
      .finally(() => {
        _activeCacheSyncPromise = null;
        if (_pendingCacheSync) {
          debouncedSyncCurrentGroupCache(1200);
        }
      });
  }, delayMs);
}

function requestForcedCurrentGroupSync(delayMs = 200) {
  _pendingForcedCacheSync = true;
  debouncedSyncCurrentGroupCache(delayMs);
}

function canRestoreTimelineFromCache() {
  return state.groupBy === 'date'
    && Array.isArray(state.allClusters)
    && state.allClusters.length > 0;
}

function restoreTimelineFromCache() {
  state.inDetailsView = false;
  state.peopleViewActive = false;
  state.treeViewActive = false;
  state.openedFromMap = false;
  state.openedFromPeople = false;
  state.openedFromTree = false;
  state.filteredClusters = Array.isArray(state.filteredClusters) && state.filteredClusters.length > 0
    ? [...state.filteredClusters]
    : [...state.allClusters];
  if (ui.slider) ui.slider.oninput = debouncedApplyFilters;
  applyFilters();
  if (_pendingCacheSync) {
    debouncedSyncCurrentGroupCache(200);
  }
}

function isSummaryBackedGroup(groupBy) {
  return groupBy === 'date' || groupBy === 'location' || groupBy === 'tag';
}

function shouldRefreshAfterAnalysisComplete() {
  if (state.peopleViewActive || state.treeViewActive) return true;
  if (state.inDetailsView) return false;
  return true;
}

async function fetchPagedSummaryClusters(groupBy) {
  const clusters = [];
  let cursor = 0;
  while (true) {
    const page = await window.api.invoke('get-cluster-page', { groupBy, cursor, limit: 200 });
    if (!page || !Array.isArray(page.clusters)) break;
    clusters.push(...page.clusters);
    if (!page.hasMore) break;
    cursor = page.nextCursor;
  }
  return clusters;
}

async function fetchClustersForGroup(groupBy, options = {}) {
  if (!options.fullItems && isSummaryBackedGroup(groupBy)) {
    const clusters = await fetchInitialSummaryClusters(groupBy);
    state.clusterDataModeByGroup[groupBy] = 'summary';
    scheduleRemainingSummaryLoad(groupBy, 900);
    return clusters;
  }
  const result = await window.api.invoke('get-events', { groupBy, ...options });
  const clusters = Array.isArray(result) ? result : [];
  state.clusterDataModeByGroup[groupBy] = options.fullItems ? 'full' : (isSummaryBackedGroup(groupBy) ? 'summary' : 'full');
  return clusters;
}

async function loadInitialClustersForGroup(groupBy) {
  if (isSummaryBackedGroup(groupBy)) {
    return fetchClustersForGroup(groupBy);
  }
  const result = await window.api.invoke('read-images', { groupBy });
  return Array.isArray(result?.clusters) ? result.clusters : [];
}

// Per-phase progress tracking for concurrent pipeline
const _phaseProgress = { scan: 0, metadata: 0, ai: 0, faces: 0, vectors: 0 };
const _phaseWeights = { scan: 0.10, metadata: 0.15, ai: 0.30, faces: 0.25, vectors: 0.20 };
const _phasesStarted = new Set();
const _phasesDone = new Set();
function _updateLoadingAggregate() {
  if (!isLoadingVisible()) return;
  const total = _phaseProgress.scan * _phaseWeights.scan
    + _phaseProgress.metadata * _phaseWeights.metadata
    + _phaseProgress.ai * _phaseWeights.ai
    + _phaseProgress.faces * _phaseWeights.faces
    + _phaseProgress.vectors * _phaseWeights.vectors;
  setLoadingProgress(total);
}
function _markPipelinePhaseDone(phase) {
  _phasesDone.add(phase);
  const pipelinePhases = ['ai', 'faces', 'vectors'];
  const started = pipelinePhases.filter(p => _phasesStarted.has(p));
  if (started.length > 0 && started.every(p => _phasesDone.has(p)) && isLoadingVisible()) {
    _skipToTimeline();
  }
}

function showSkipButton() {
  if (ui.loadingSkipBtn) {
    ui.loadingSkipBtn.classList.remove('hidden');
  }
  if (isLoadingVisible()) {
    setLoadingSubtitle('Your photos are ready — click Skip to browse while we finish up.');
  }
}

async function _skipToTimeline() {
  if (!state._pendingFirstRender && !isLoadingVisible()) return;

  try {
    if (Array.isArray(state._readyClusters) && state._readyClusters.length > 0) {
      state.allClusters = state._readyClusters;
      state.clusterDataModeByGroup[state.groupBy] = isSummaryBackedGroup(state.groupBy) ? 'summary' : 'full';
    } else if (isSummaryBackedGroup(state.groupBy)) {
      const clusters = await fetchClustersForGroup(state.groupBy);
      if (clusters.length > 0) {
        state.allClusters = clusters;
        state.clusterDataModeByGroup[state.groupBy] = 'summary';
      }
    } else {
      const result = await window.api.invoke('read-images', { groupBy: state.groupBy });
      if (Array.isArray(result.clusters) && result.clusters.length > 0) {
        state.allClusters = result.clusters;
        state.clusterDataModeByGroup[state.groupBy] = 'full';
      }
    }
  } catch (_) {
    if (state._readyClusters) {
      state.allClusters = state._readyClusters;
    }
  }
  state._readyClusters = null;
  state._pendingFirstRender = false;

  if (!state.allClusters || state.allClusters.length === 0) return;

  state.filteredClusters = [...state.allClusters];
  if (ui.slider) ui.slider.oninput = debouncedApplyFilters;
  dismissLoading();
  applyFilters();
}

// ---------------------------------------------------------------------------
// User-activity heartbeat for polite background indexing
// ---------------------------------------------------------------------------

let lastUserActivityPingAt = 0;

function notifyUserActivity(force = false) {
  _lastRendererInteractionAt = Date.now();
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

// ---------------------------------------------------------------------------
// Library dirty badge
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Group-by switching
// ---------------------------------------------------------------------------

async function refreshViewMode() {
  updateNavActiveState();
  setStatusMessage('Reclustering memories...');
  try {
    const data = await fetchClustersForGroup(state.groupBy);
    state.allClusters = data;
    state.filteredClusters = [...data];
    state.clusterElements.clear();
    state.lastPositions = [];
    applyFilters();
    setStatusMessage(`Loaded ${data.length} clusters.`, { autoHideMs: 2000 });
  } catch (err) {
    setStatusMessage(`Error: ${err.message}`);
  }
}

async function switchGroupBy(nextGroupBy) {
  if (state.groupBy === nextGroupBy) return;
  state.groupBy = nextGroupBy;
  state.personFilter = null;

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

// ---------------------------------------------------------------------------
// IPC event listeners
// ---------------------------------------------------------------------------

function bindIPCListeners() {
  if (!window.api || !window.api.on) return;

  window.api.on('indexing-progress', (_event, data) => {
    ui.status.innerText = `✨ ${data.message} (${data.percentage}%)`;
    if (isLoadingVisible()) {
      setLoadingPhase('metadata');
      setLoadingSubtitle('Scanning & processing files...');
      _phaseProgress.scan = data.percentage;
      _updateLoadingAggregate();
      setLoadingDetail(`${data.current} / ${data.total} files`);
    }
  });

  window.api.on('library-refresh-complete', (_event, data) => {
    state.libraryDirty = false;
    updateLibraryDirtyUI();
    if (isLoadingVisible()) {
      _phaseProgress.scan = 100;
      markPhaseDone('scan');
      _updateLoadingAggregate();
    }
    if (data?.reason !== 'manual') {
      debouncedSyncCurrentGroupCache();
    }
  });

  window.api.on('library-change-detected', () => {
    state.libraryDirty = true;
    updateLibraryDirtyUI();
  });

  window.api.on('library-refresh-error', (_event, data) => {
    ui.status.innerText = `Refresh failed: ${data.message}`;
    ui.status.style.opacity = '1';
  });

  window.api.on('metadata-processing-started', () => {
    _phasesStarted.add('metadata');
    if (isLoadingVisible()) {
      setLoadingPhase('metadata');
      setLoadingSubtitle('Processing photo metadata...');
    }
  });

  window.api.on('metadata-batch-progress', (_event, data) => {
    ui.status.innerText = `Processing metadata: ${data.current} / ${data.total} (${data.percentage}%)`;
    ui.status.style.opacity = '1';
    if (isLoadingVisible()) {
      _phaseProgress.metadata = data.percentage;
      _updateLoadingAggregate();
      setLoadingDetail(`${data.current} / ${data.total} files`);
    }
  });

  window.api.on('metadata-batch-ready', async (_event, data) => {
    if (state._pendingFirstRender && isLoadingVisible() && data?.processed > 0) {
      showSkipButton();
    }
  });

  window.api.on('metadata-processing-complete', async () => {
    _phaseProgress.metadata = 100;
    _phasesDone.add('metadata');
    _updateLoadingAggregate();
    if (state._pendingFirstRender) {
      try {
        const readyClusters = isSummaryBackedGroup(state.groupBy)
          ? await fetchClustersForGroup(state.groupBy)
          : (await window.api.invoke('read-images', { groupBy: state.groupBy })).clusters;
        const ready = Array.isArray(readyClusters) && readyClusters.some(c =>
          c.items && c.items[0] && c.items[0].thumbnailPath
        );
        if (ready) {
          state._readyClusters = readyClusters;
          showSkipButton();
        }
      } catch (_) { }
    }
    if (ui.status.innerText.startsWith('Processing metadata')) {
      ui.status.innerText = '';
      ui.status.style.opacity = '0';
    }
  });

  window.api.on('face-indexing-started', (_event, data) => {
    _phasesStarted.add('faces');
    ui.status.innerText = `Analyzing faces: 0 / ${data.total}`;
    ui.status.style.opacity = '1';
    if (isLoadingVisible()) {
      setLoadingPhase('faces');
      setLoadingSubtitle('Recognizing faces...');
      setLoadingDetail(`0 / ${data.total}`);
    }
  });

  window.api.on('face-indexing-progress', (_event, data) => {
    ui.status.innerText = `Analyzing faces: ${data.current} / ${data.total} (${data.percentage}%)`;
    ui.status.style.opacity = '1';
    if (isLoadingVisible()) {
      _phaseProgress.faces = data.percentage;
      _updateLoadingAggregate();
      setLoadingDetail(`${data.current} / ${data.total} faces`);
    }
  });

  window.api.on('face-indexing-complete', (_event, data) => {
    state.indexingComplete.faces = true;
    const seconds = typeof data?.durationMs === 'number' ? (data.durationMs / 1000).toFixed(1) : null;
    ui.status.innerText = seconds ? `Face indexing complete in ${seconds}s` : 'Face indexing complete';
    ui.status.style.opacity = '1';
    if (isLoadingVisible()) {
      _phaseProgress.faces = 100;
      markPhaseDone('faces');
      setLoadingDetail('');
      _updateLoadingAggregate();
    }
    _markPipelinePhaseDone('faces');
    setTimeout(() => {
      if (ui.status.innerText.startsWith('Face indexing complete')) {
        ui.status.innerText = '';
        ui.status.style.opacity = '0';
      }
    }, 1800);
    if (state.peopleViewActive) {
      refreshPeopleGallery(switchGroupBy).catch((error) => {
        console.error('Failed to refresh people gallery after face indexing:', error);
      });
    }
    if (shouldRefreshAfterAnalysisComplete()) {
      requestForcedCurrentGroupSync();
    }
  });

  window.api.on('visual-indexing-started', (_event, data) => {
    _phasesStarted.add('ai');
    ui.status.innerText = `Analyzing : 0 / ${data.total}`;
    ui.status.style.opacity = '1';
    if (isLoadingVisible()) {
      setLoadingPhase('ai');
      setLoadingSubtitle('AI analyzing your photos...');
      setLoadingDetail(`0 / ${data.total}`);
    }
  });

  window.api.on('visual-indexing-progress', (_event, data) => {
    ui.status.innerText = `Analyzing : ${data.current} / ${data.total} (${data.percentage}%)`;
    ui.status.style.opacity = '1';
    if (isLoadingVisible()) {
      _phaseProgress.ai = data.percentage;
      _updateLoadingAggregate();
      setLoadingDetail(`${data.current} / ${data.total} images`);
    }
  });

  window.api.on('visual-indexing-complete', (_event, data) => {
    state.indexingComplete.visual = true;
    const seconds = typeof data?.durationMs === 'number' ? (data.durationMs / 1000).toFixed(1) : null;
    ui.status.innerText = seconds ? `Analysis complete in ${seconds}s` : 'Analysis complete';
    ui.status.style.opacity = '1';
    if (isLoadingVisible()) {
      _phaseProgress.ai = 100;
      markPhaseDone('ai');
      setLoadingDetail('');
      _updateLoadingAggregate();
    }
    _markPipelinePhaseDone('ai');
    setTimeout(() => {
      if (ui.status.innerText.startsWith('Analysis complete')) {
        ui.status.innerText = '';
        ui.status.style.opacity = '0';
      }
    }, 1800);
    if (state.peopleViewActive) {
      refreshPeopleGallery(switchGroupBy).catch((error) => {
        console.error('Failed to refresh people gallery after visual indexing:', error);
      });
    }
    if (shouldRefreshAfterAnalysisComplete()) {
      requestForcedCurrentGroupSync();
    }
  });

  window.api.on('semantic-indexing-started', (_event, data) => {
    _phasesStarted.add('vectors');
    ui.status.innerText = `Indexing search vectors: 0 / ${data.total}`;
    ui.status.style.opacity = '1';
    if (isLoadingVisible()) {
      setLoadingPhase('vectors');
      setLoadingSubtitle('Building search index...');
      setLoadingDetail(`0 / ${data.total}`);
    }
  });

  window.api.on('semantic-indexing-progress', (_event, data) => {
    ui.status.innerText = `Indexing search vectors: ${data.current} / ${data.total} (${data.percentage}%)`;
    ui.status.style.opacity = '1';
    if (isLoadingVisible()) {
      _phaseProgress.vectors = data.percentage;
      _updateLoadingAggregate();
      setLoadingDetail(`${data.current} / ${data.total} vectors`);
    }
  });

  window.api.on('semantic-indexing-complete', (_event, data) => {
    state.indexingComplete.vectors = true;
    const seconds = typeof data?.durationMs === 'number' ? (data.durationMs / 1000).toFixed(1) : null;
    ui.status.innerText = seconds ? `Search indexing complete in ${seconds}s` : 'Search indexing complete';
    ui.status.style.opacity = '1';
    if (isLoadingVisible()) {
      _phaseProgress.vectors = 100;
      markPhaseDone('vectors');
      _updateLoadingAggregate();
    }
    _markPipelinePhaseDone('vectors');
    setTimeout(() => {
      if (ui.status.innerText.startsWith('Search indexing complete')) {
        ui.status.innerText = '';
        ui.status.style.opacity = '0';
      }
    }, 1800);
  });

  window.api.on('model-load-error', (_event, data) => {
    console.warn('[Models] Load error:', data.message);
    state.indexingComplete.visual = true;
    state.indexingComplete.faces = true;
    state.indexingComplete.vectors = true;
    ui.status.innerText = data.hint || 'AI features are unavailable — check your connection and restart.';
    ui.status.style.opacity = '1';
    if (isLoadingVisible()) {
      markPhaseDone('ai');
      markPhaseDone('faces');
      markPhaseDone('vectors');
      setLoadingSubtitle('AI models unavailable — basic features still work');
      setTimeout(() => dismissLoading(), 2000);
    }
  });
}

function bindOptimizedIPCListeners() {
  if (!window.api || !window.api.on) return;

  window.api.on('indexing-progress', (_event, data) => {
    setProgressStatus('scan', `Indexing: ${data.message} (${data.percentage}%)`, data.percentage);
    if (isLoadingVisible()) {
      setLoadingPhase('metadata');
      setLoadingSubtitle('Scanning & processing files...');
      _phaseProgress.scan = data.percentage;
      _updateLoadingAggregate();
      setLoadingDetail(`${data.current} / ${data.total} files`);
    }
  });

  window.api.on('library-refresh-complete', (_event, data) => {
    state.libraryDirty = false;
    updateLibraryDirtyUI();
    if (isLoadingVisible()) {
      _phaseProgress.scan = 100;
      markPhaseDone('scan');
      _updateLoadingAggregate();
    }
    if (data?.reason !== 'manual') {
      debouncedSyncCurrentGroupCache();
    }
  });

  window.api.on('library-change-detected', () => {
    state.libraryDirty = true;
    updateLibraryDirtyUI();
  });

  window.api.on('library-refresh-error', (_event, data) => {
    setStatusMessage(`Refresh failed: ${data.message}`);
  });

  window.api.on('metadata-processing-started', () => {
    _phasesStarted.add('metadata');
    if (isLoadingVisible()) {
      setLoadingPhase('metadata');
      setLoadingSubtitle('Processing photo metadata...');
    }
  });

  window.api.on('metadata-batch-progress', (_event, data) => {
    setProgressStatus('metadata', `Processing metadata: ${data.current} / ${data.total} (${data.percentage}%)`, data.percentage);
    if (isLoadingVisible()) {
      _phaseProgress.metadata = data.percentage;
      _updateLoadingAggregate();
      setLoadingDetail(`${data.current} / ${data.total} files`);
    }
  });

  window.api.on('metadata-batch-ready', async (_event, data) => {
    if (state._pendingFirstRender && isLoadingVisible() && data?.processed > 0) {
      showSkipButton();
    }
  });

  window.api.on('metadata-processing-complete', async () => {
    _phaseProgress.metadata = 100;
    _phasesDone.add('metadata');
    _updateLoadingAggregate();
    if (state._pendingFirstRender) {
      try {
        const readyClusters = isSummaryBackedGroup(state.groupBy)
          ? await fetchClustersForGroup(state.groupBy)
          : (await window.api.invoke('read-images', { groupBy: state.groupBy })).clusters;
        const ready = Array.isArray(readyClusters) && readyClusters.some((c) =>
          c.items && c.items[0] && c.items[0].thumbnailPath
        );
        if (ready) {
          state._readyClusters = readyClusters;
          showSkipButton();
        }
      } catch (_) { }
    }
    clearStatusMessage({ prefixes: ['Processing metadata'] });
  });

  window.api.on('face-indexing-started', (_event, data) => {
    _phasesStarted.add('faces');
    setStatusMessage(`Analyzing faces: 0 / ${data.total}`);
    if (isLoadingVisible()) {
      setLoadingPhase('faces');
      setLoadingSubtitle('Recognizing faces...');
      setLoadingDetail(`0 / ${data.total}`);
    }
  });

  window.api.on('face-indexing-progress', (_event, data) => {
    setProgressStatus('faces', `Analyzing faces: ${data.current} / ${data.total} (${data.percentage}%)`, data.percentage);
    if (isLoadingVisible()) {
      _phaseProgress.faces = data.percentage;
      _updateLoadingAggregate();
      setLoadingDetail(`${data.current} / ${data.total} faces`);
    }
  });

  window.api.on('face-indexing-complete', (_event, data) => {
    state.indexingComplete.faces = true;
    const seconds = typeof data?.durationMs === 'number' ? (data.durationMs / 1000).toFixed(1) : null;
    setStatusMessage(seconds ? `Face indexing complete in ${seconds}s` : 'Face indexing complete', { autoHideMs: 1800 });
    if (isLoadingVisible()) {
      _phaseProgress.faces = 100;
      markPhaseDone('faces');
      setLoadingDetail('');
      _updateLoadingAggregate();
    }
    _markPipelinePhaseDone('faces');
    if (state.peopleViewActive) {
      refreshPeopleGallery(switchGroupBy).catch((error) => {
        console.error('Failed to refresh people gallery after face indexing:', error);
      });
    }
    if (shouldRefreshAfterAnalysisComplete()) {
      debouncedSyncCurrentGroupCache();
    }
  });

  window.api.on('visual-indexing-started', (_event, data) => {
    _phasesStarted.add('ai');
    setStatusMessage(`Analyzing: 0 / ${data.total}`);
    if (isLoadingVisible()) {
      setLoadingPhase('ai');
      setLoadingSubtitle('AI analyzing your photos...');
      setLoadingDetail(`0 / ${data.total}`);
    }
  });

  window.api.on('visual-indexing-progress', (_event, data) => {
    setProgressStatus('visual', `Analyzing: ${data.current} / ${data.total} (${data.percentage}%)`, data.percentage);
    if (isLoadingVisible()) {
      _phaseProgress.ai = data.percentage;
      _updateLoadingAggregate();
      setLoadingDetail(`${data.current} / ${data.total} images`);
    }
  });

  window.api.on('visual-indexing-complete', (_event, data) => {
    state.indexingComplete.visual = true;
    const seconds = typeof data?.durationMs === 'number' ? (data.durationMs / 1000).toFixed(1) : null;
    setStatusMessage(seconds ? `Analysis complete in ${seconds}s` : 'Analysis complete', { autoHideMs: 1800 });
    if (isLoadingVisible()) {
      _phaseProgress.ai = 100;
      markPhaseDone('ai');
      setLoadingDetail('');
      _updateLoadingAggregate();
    }
    _markPipelinePhaseDone('ai');
    if (state.peopleViewActive) {
      refreshPeopleGallery(switchGroupBy).catch((error) => {
        console.error('Failed to refresh people gallery after visual indexing:', error);
      });
    }
    if (shouldRefreshAfterAnalysisComplete()) {
      debouncedSyncCurrentGroupCache();
    }
  });

  window.api.on('semantic-indexing-started', (_event, data) => {
    _phasesStarted.add('vectors');
    setStatusMessage(`Indexing search vectors: 0 / ${data.total}`);
    if (isLoadingVisible()) {
      setLoadingPhase('vectors');
      setLoadingSubtitle('Building search index...');
      setLoadingDetail(`0 / ${data.total}`);
    }
  });

  window.api.on('semantic-indexing-progress', (_event, data) => {
    setProgressStatus('vectors', `Indexing search vectors: ${data.current} / ${data.total} (${data.percentage}%)`, data.percentage);
    if (isLoadingVisible()) {
      _phaseProgress.vectors = data.percentage;
      _updateLoadingAggregate();
      setLoadingDetail(`${data.current} / ${data.total} vectors`);
    }
  });

  window.api.on('semantic-indexing-complete', (_event, data) => {
    state.indexingComplete.vectors = true;
    const seconds = typeof data?.durationMs === 'number' ? (data.durationMs / 1000).toFixed(1) : null;
    setStatusMessage(seconds ? `Search indexing complete in ${seconds}s` : 'Search indexing complete', { autoHideMs: 1800 });
    if (isLoadingVisible()) {
      _phaseProgress.vectors = 100;
      markPhaseDone('vectors');
      _updateLoadingAggregate();
    }
    _markPipelinePhaseDone('vectors');
  });

  window.api.on('model-load-error', (_event, data) => {
    console.warn('[Models] Load error:', data.message);
    state.indexingComplete.visual = true;
    state.indexingComplete.faces = true;
    state.indexingComplete.vectors = true;
    setStatusMessage(data.hint || 'AI features are unavailable - check your connection and restart.');
    if (isLoadingVisible()) {
      markPhaseDone('ai');
      markPhaseDone('faces');
      markPhaseDone('vectors');
      setLoadingSubtitle('AI models unavailable - basic features still work');
      setTimeout(() => dismissLoading(), 2000);
    }
  });
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadImages() {
  try {
    setLoadingSubtitle('Loading your memories...');
    setLoadingPhase('scan');
    ui.status.innerText = 'Loading your memories...';
    ui.status.style.opacity = '1';

    const result = await window.api.invoke('read-images', { groupBy: state.groupBy, skipClusters: true });
    state.allClusters = await loadInitialClustersForGroup(state.groupBy);
    state.clusterDataModeByGroup[state.groupBy] = isSummaryBackedGroup(state.groupBy) ? 'summary' : 'full';
    const indexDebug = result.indexDebug;
    state.libraryDirty = Boolean(indexDebug?.libraryDirty);
    updateLibraryDirtyUI();

    if (!Array.isArray(state.allClusters) || state.allClusters.length === 0) {
      if (!indexDebug?.latestRun) {
        setLoadingSubtitle('First run — discovering your photos...');
        await refreshLibrary();
        return;
      }
      const previouslyScanned = indexDebug.latestRun.scannedCount > 0;
      if (previouslyScanned) {
        setLoadingSubtitle('Re-indexing your library...');
        ui.status.innerText = 'Rebuilding library...';
        ui.status.style.opacity = '1';
        await refreshLibrary();
        return;
      }
      ui.status.innerText = 'No supported images found in your configured folders.';
      dismissLoading();
      renderEmptyState('No photos found. Open Settings to add folders with JPG/PNG/WEBP images.');
    } else {
      dismissLoading();
      if (state.libraryDirty) {
        ui.status.innerText = 'New or changed files detected. Refresh Library to update.';
        ui.status.style.opacity = '1';
      } else {
        ui.status.innerText = '';
        ui.status.style.opacity = '0';
      }
    }

    if (indexDebug) {
      ui.debug.style.opacity = '0';
    }

    state.filteredClusters = [...state.allClusters];
    if (ui.slider) ui.slider.oninput = debouncedApplyFilters;
    applyFilters();
  } catch (error) {
    dismissLoading();
    ui.status.innerText = 'Unable to load photos.';
    renderEmptyState(`Error: ${error.message || 'Unknown error'}`);
  }
}

async function refreshLibrary() {
  try {
    if (isLoadingVisible()) {
      setLoadingSubtitle('Discovering your memories...');
      setLoadingPhase('scan');
    }
    ui.status.innerText = '✨ Discovering your memories...';
    ui.status.style.opacity = '1';

    const result = await window.api.invoke('refresh-library', { groupBy: state.groupBy, skipClusters: true });
    state.allClusters = await loadInitialClustersForGroup(state.groupBy);
    state.clusterDataModeByGroup[state.groupBy] = isSummaryBackedGroup(state.groupBy) ? 'summary' : 'full';
    const indexDebug = result.indexDebug;
    state.libraryDirty = Boolean(indexDebug?.libraryDirty);
    updateLibraryDirtyUI();

    if (!Array.isArray(state.allClusters) || state.allClusters.length === 0) {
      const scannedSomething = indexDebug?.latestRun?.scannedCount > 0;
      if (scannedSomething) {
        setLoadingSubtitle('Processing your photos — this may take a moment...');
        ui.status.innerText = 'Building your library...';
        ui.status.style.opacity = '1';
      } else {
        ui.status.innerText = 'No supported images found in your configured folders.';
        dismissLoading();
        renderEmptyState('No photos found. Open Settings to add folders with JPG/PNG/WEBP images.');
      }
    } else {
      if (isLoadingVisible()) {
        markPhaseDone('scan');
      }

      const hasThumbnails = state.allClusters.some(c =>
        c.items && c.items[0] && c.items[0].thumbnailPath
      );

      if (isLoadingVisible()) {
        if (hasThumbnails) {
          state._readyClusters = [...state.allClusters];
          showSkipButton();
        } else {
          setLoadingSubtitle('Generating thumbnails...');
          setLoadingPhase('metadata');
        }
        state._pendingFirstRender = true;
      } else {
        state.filteredClusters = [...state.allClusters];
        if (ui.slider) ui.slider.oninput = debouncedApplyFilters;
        applyFilters();
      }

      ui.status.innerText = 'Enhancing metadata in the background...';
      ui.status.style.opacity = '1';
    }

    if (indexDebug) {
      ui.debug.style.opacity = '0';
    }
  } catch (error) {
    dismissLoading();
    ui.status.innerText = 'Unable to refresh library.';
    renderEmptyState(`Error: ${error.message || 'Unknown error'}`);
  }
}

// ---------------------------------------------------------------------------
// Custom dropdown helper
// ---------------------------------------------------------------------------

function setupCustomDropdown(el, onChange) {
  if (!el) return;
  const trigger = el.querySelector('.dropdown-trigger');
  const menu = el.querySelector('.dropdown-menu');
  if (!trigger || !menu) return;
  const labelEl = trigger.querySelector('.dropdown-label');
  const items = Array.from(el.querySelectorAll('.dropdown-item'));
  let focusedIdx = -1;

  function isOpen() { return menu.classList.contains('show'); }

  function openMenu() {
    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
    document.querySelectorAll('.dropdown-trigger').forEach(t => { t.classList.remove('open'); t.setAttribute('aria-expanded', 'false'); });
    menu.classList.add('show');
    trigger.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    focusedIdx = items.findIndex(i => i.classList.contains('active'));
    if (focusedIdx >= 0) items[focusedIdx].classList.add('focused');
  }

  function closeMenu(returnFocus) {
    menu.classList.remove('show');
    trigger.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    items.forEach(i => i.classList.remove('focused'));
    focusedIdx = -1;
    if (returnFocus) trigger.focus();
  }

  function selectItem(item) {
    const val = item.getAttribute('data-value');
    items.forEach(i => { i.classList.remove('active'); i.setAttribute('aria-selected', 'false'); });
    item.classList.add('active');
    item.setAttribute('aria-selected', 'true');
    if (labelEl) labelEl.innerText = item.innerText;
    onChange(val);
    closeMenu(true);
  }

  function moveFocus(delta) {
    if (items.length === 0) return;
    items.forEach(i => i.classList.remove('focused'));
    focusedIdx = (focusedIdx + delta + items.length) % items.length;
    items[focusedIdx].classList.add('focused');
    items[focusedIdx].scrollIntoView({ block: 'nearest' });
  }

  trigger.onclick = (e) => {
    e.stopPropagation();
    isOpen() ? closeMenu(true) : openMenu();
  };

  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      if (!isOpen()) openMenu();
      else if (e.key === 'ArrowDown') moveFocus(1);
    } else if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      closeMenu(true);
    }
  });

  el.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(-1); }
    else if ((e.key === 'Enter' || e.key === ' ') && focusedIdx >= 0) { e.preventDefault(); selectItem(items[focusedIdx]); }
    else if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (e.key === 'Home') { e.preventDefault(); focusedIdx = -1; moveFocus(1); }
    else if (e.key === 'End') { e.preventDefault(); focusedIdx = items.length; moveFocus(-1); }
    else if (e.key === 'Tab') { closeMenu(false); }
  });

  items.forEach(item => {
    item.onclick = (e) => {
      e.stopPropagation();
      selectItem(item);
    };
  });
}

// ---------------------------------------------------------------------------
// Viewport interactions
// ---------------------------------------------------------------------------

function bindInteractions() {
  // Map popup click delegation
  document.addEventListener('click', (event) => {
    const popupTrigger = event.target.closest('.map-popup-link');
    if (popupTrigger) {
      event.preventDefault();
      focusClusterFromMap(popupTrigger.dataset.clusterId);
      return;
    }
  });

  // Viewport panning
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
      scheduleConnectionsRedraw(state.lastPositions);
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

  function endAllDrags() {
    if (state.draggedNodeId) {
      if (state.nodeDragMoved) state.suppressClickUntil = Date.now() + 180;
      state.draggedNodeId = null;
      state.nodeDragMoved = false;
    }
    if (state.dragMoved) state.suppressClickUntil = Date.now() + 180;
    state.isDraggingViewport = false;
    ui.viewport.classList.remove('dragging');
  }

  window.addEventListener('mouseup', endAllDrags);
  window.addEventListener('blur', endAllDrags);

  // Keyboard shortcuts
  window.addEventListener('keydown', async (e) => {
    if (handleTreeKeydown(e)) { e.preventDefault(); return; }

    if (e.key === 'Backspace') {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
        return;
      }
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
        scheduleConnectionsRedraw(state.lastPositions);
      }
      if (ui.settingsModal && !ui.settingsModal.classList.contains('hidden')) {
        ui.settingsModal.classList.add('hidden');
      }
      if (ui.renameModal && !ui.renameModal.classList.contains('hidden')) {
        ui.renameModal.classList.add('hidden');
      }
    }
  });

  // Zoom / horizontal scroll
  ui.viewport.addEventListener('wheel', (e) => {
    if (state.inDetailsView) return;

    const isZoom = e.ctrlKey || e.metaKey || (Math.abs(e.deltaY) > Math.abs(e.deltaX));

    if (isZoom) {
      e.preventDefault();
      const zoomSpeed = 0.0015;
      const delta = -e.deltaY;
      const oldScale = state.scale;

      state.scale = Math.max(0.12, Math.min(1.0, state.scale + delta * zoomSpeed));

      const rect = ui.viewport.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

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
      state.offsetX -= e.deltaX * 1.5;
      clampOffsets();
      setTransform();
      e.preventDefault();
    }
  }, { passive: false });

  function clampOffsets() {
    const vw = ui.viewport.clientWidth;
    const vh = ui.viewport.clientHeight;
    const minX = -(GRAPH.width * state.scale - 200);
    const maxX = vw - 200;
    const minY = -(GRAPH.height * state.scale - 200);
    const maxY = vh - 200;
    state.offsetX = Math.max(minX, Math.min(maxX, state.offsetX));
    state.offsetY = Math.max(minY, Math.min(maxY, state.offsetY));
  }

  // Recenter button
  if (ui.floatingRecenterBtn) {
    ui.floatingRecenterBtn.addEventListener('click', () => {
      centerOnPositions(state.lastPositions);
      if (ui.floatingRecenterBtn) {
        ui.floatingRecenterBtn.classList.add('hidden');
      }
    });
  }

  // Clear cache
  if (ui.clearCacheActionBtn) ui.clearCacheActionBtn.addEventListener('click', async () => {
    if (confirm('This will wipe all indexed data (thumbnails, AI tags, face data, search index) and close the app.\n\nYou will need to re-open the app to rebuild your library.\n\nContinue?')) {
      ui.clearCacheActionBtn.disabled = true;
      const iconEl = ui.clearCacheActionBtn.querySelector('.action-btn-icon svg');
      if (iconEl) iconEl.classList.add('spin');
      const textEl = ui.clearCacheActionBtn.querySelector('.action-btn-text strong');
      if (textEl) textEl.textContent = 'Clearing...';
      try {
        await window.api.invoke('clear-cache');
      } catch (err) {
        console.error('Clear cache failed:', err);
        ui.clearCacheActionBtn.disabled = false;
        if (iconEl) iconEl.classList.remove('spin');
        if (textEl) textEl.textContent = 'Clear Cache';
      }
    }
  });

  function onActivate(el, handler) {
    el.onclick = handler;
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handler(e);
      }
    });
  }

  // Navigation tabs
  onActivate(ui.navTimeline, async () => {
    const token = ++state.navigationToken;
    hidePeopleToolbar();
    closeFamilyTree();
    if (ui.timelineWrap) ui.timelineWrap.classList.remove('hidden');
    resetViewportContext();
    setMapVisibility(false, { skipRender: true });
    if (canRestoreTimelineFromCache()) {
      restoreTimelineFromCache();
      if (token !== state.navigationToken) return;
      updateNavActiveState();
      return;
    }
    await switchGroupBy('date');
    if (token !== state.navigationToken) return;
    if (state.groupBy === 'date') {
      refreshViewMode();
    }
  });

  onActivate(ui.navPeople, async () => {
    ++state.navigationToken;
    closeFamilyTree();
    await openPeopleGallery(switchGroupBy);
  });

  onActivate(ui.navFamilyTree, async () => {
    ++state.navigationToken;
    closeFamilyTree();
    await openFamilyTree(switchGroupBy);
  });

  // Custom dropdowns
  setupCustomDropdown(ui.groupBySelect, (val) => {
    switchGroupBy(val);
  });

  setupCustomDropdown(ui.mapStyleSelect, (val) => {
    setMapStyle(val);
  });

  setupCustomDropdown(ui.peopleSortSelect, (val) => {
    state.peopleSortBy = val;
    resortPeopleGallery(switchGroupBy);
  });

  // Close dropdowns on outside click
  document.addEventListener('click', () => {
    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
    document.querySelectorAll('.dropdown-trigger').forEach(t => {
      t.classList.remove('open');
      t.setAttribute('aria-expanded', 'false');
    });
  });

  // Map toggle
  onActivate(ui.navMap, async () => {
    const token = ++state.navigationToken;
    hidePeopleToolbar();
    closeFamilyTree();
    if (ui.timelineWrap) ui.timelineWrap.classList.remove('hidden');
    const willShow = !state.showMap;
    if (willShow) {
      resetViewportContext();
      await switchGroupBy('location');
      if (token !== state.navigationToken) return;
    } else {
      resetViewportContext();
      setMapVisibility(false, { skipRender: true });
      if (canRestoreTimelineFromCache()) {
        restoreTimelineFromCache();
        if (token !== state.navigationToken) return;
        updateNavActiveState();
        return;
      }
      await switchGroupBy('date');
      if (token !== state.navigationToken) return;
      if (state.groupBy === 'date') {
        refreshViewMode();
      }
      return;
    }
    setMapVisibility(willShow);
  });

  // Fit-map button
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

  // Settings modal
  onActivate(ui.manageFoldersBtn, async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const settings = await window.api.invoke('get-index-roots');
      state.indexRoots = Array.isArray(settings) ? settings : (settings?.roots || []);
      ui.includeVideosCheckbox.checked = settings.includeVideos !== false;
      renderRootsList();
      ui.settingsModal.classList.remove('hidden');
    } catch (err) {
      console.error('Failed to open folders:', err);
      alert('Could not open folder settings.');
    }
  });

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

  // Search input with semantic debounce
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
        setStatusMessage(`Location "${state.searchQuery}" not found on map`, { autoHideMs: 3000 });
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

    if (state.searchQuery.length > 0 && state.clusterDataModeByGroup[state.groupBy] !== 'full' && (state.groupBy === 'date' || state.groupBy === 'location' || state.groupBy === 'tag')) {
      progressivelyHydrateClusters({
        visibleOnly: false,
        onBatch: () => {
          if (state.searchQuery.length > 0) {
            applyFilters();
          }
        },
      }).catch((err) => {
        console.error('Failed to progressively hydrate clusters for search:', err);
      });
    }

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
          console.error('Semantic search failed:', err);
          ui.status.innerText = 'Visual search unavailable — try a keyword search instead';
          ui.status.style.opacity = '1';
          setTimeout(() => {
            if (ui.status.innerText.includes('Visual search unavailable')) {
              ui.status.innerText = '';
              ui.status.style.opacity = '0';
            }
          }, 4000);
          return;
        }
        ui.status.innerText = '';
        ui.status.style.opacity = '0';
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

  // Refresh library button
  if (ui.refreshLibraryBtn) ui.refreshLibraryBtn.addEventListener('click', async () => {
    ui.refreshLibraryBtn.disabled = true;
    const iconEl = ui.refreshLibraryBtn.querySelector('.action-btn-icon svg');
    const textEl = ui.refreshLibraryBtn.querySelector('.action-btn-text strong');
    const subtextEl = ui.refreshLibraryBtn.querySelector('.action-btn-text small');
    if (iconEl) iconEl.classList.add('spin');
    if (textEl) textEl.textContent = 'Refreshing...';
    if (subtextEl) subtextEl.textContent = 'Scanning folders for changes...';
    try {
      await refreshLibrary();
    } finally {
      ui.refreshLibraryBtn.disabled = false;
      if (iconEl) iconEl.classList.remove('spin');
      if (textEl) textEl.textContent = 'Refresh Library';
      if (subtextEl) subtextEl.textContent = 'Re-scan folders for new or changed files';
    }
  });

  // Resize handling
  window.addEventListener('resize', () => {
    notifyUserActivity(false);
    if (state.showMap && state.map) {
      state.map.invalidateSize(false);
      updateMapMarkers(state.filteredClusters);
      return;
    }
    clearTimeout(_resizeRelayoutTimer);
    _resizeRelayoutTimer = setTimeout(() => {
      if (!state.inDetailsView) {
        relayoutClustersForViewport();
      }
    }, 140);
  });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

registerGraphCallbacks({ openCluster, renderClusters, updateNavActiveState });
updateModeToolbar();
bindUserActivitySignals();
bindSearchListeners();
bindOptimizedIPCListeners();
bindInteractions();
if (ui.loadingSkipBtn) {
  ui.loadingSkipBtn.addEventListener('click', () => _skipToTimeline());
}
loadImages();
