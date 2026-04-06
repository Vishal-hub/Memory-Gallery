# Memory Gallery Recovery + Low-RAM Scalability Plan

## Summary

This document is the implementation contract for the reset-and-rebuild migration of Memory Gallery.

The previously attempted worker/model-download branch was not used as the base for new work. It introduced partial offloading work, but the request/response contract, preload channel list, renderer listeners, and startup behavior drifted out of sync. The recovery path starts by restoring the stable single-process baseline, then rebuilding toward low-RAM scalability in explicit phases.

Primary product target:

- Windows baseline: `4 GB RAM`, `4 logical cores`
- Product behavior: metadata-first
- Success rule: the user can browse photos before AI models are ready, while AI analysis continues later in the background

## Why Reset First

The rollback decision was based on confirmed defects in the abandoned branch:

- The worker request/response contract was inconsistent and could not complete refresh requests reliably.
- The preload whitelist and emitted event names diverged, causing renderer listeners to miss progress events.
- The renderer ended up with duplicate and conflicting refresh handlers.
- Startup could stall when models were already present because browse-mode loading was no longer the default path.
- Worker messaging assumptions were mixed between `process.parentPort` and Electron-owned transport access.

This recovery pass intentionally keeps the app single-process until paging and renderer cleanup are in place.

## Phase 0: Recovery Baseline

Completed in this recovery pass:

- Removed the unfinished worker/model-download branch changes from main, preload, renderer, indexer, packaging, and HTML startup flow.
- Removed the in-progress worker directory and temporary model manager implementation.
- Restored the stable startup path where the app always attempts to load the library immediately.

## Phase 1: Low-RAM Stabilization

Implemented in this pass:

- Reduced heavy indexing concurrency for weak Windows machines:
  - metadata/index batch size: `2`
  - visual batch size: `1`
  - face batch size: `1`
  - embedding processing inherits the face batch size of `1`
- Reduced background metadata batch size to `2` for both initial and subsequent background processing.
- Delayed AI warmup and made it sequential so the first-run browse path wins on low-memory systems.
- Stopped repeated library-wide `read-images` refreshes during metadata progress.
  - metadata progress now updates UI state without reloading the entire library snapshot
  - the app performs a single full re-read at metadata completion instead of on every batch
- Switched the detail grid to preview-first loading.
  - cluster detail grids now use thumbnail/converted preview assets
  - the lightbox continues to open the original image path when the user explicitly opens a photo

Expected impact:

- Lower peak RAM during import
- Reduced main-process stalls from repeated library reconstruction
- Faster time-to-first-browse on weak machines

## Next Phases

### Phase 2: Data Path Refactor

- Replace full-library browsing payloads with:
  - `getLibrarySummary()`
  - `getClusterPage({ groupBy, cursor, limit, filters })`
  - `getClusterItems({ clusterId, cursor, limit, previewOnly })`
  - `getIndexProgress()`
- Stop using full-library `read-images` / `get-events` as the default browse contract.
- Return cluster summaries and cover assets first; load full item arrays only for opened clusters.
- Replace in-memory regrouping for `tag` and `person` views with query-backed projections.

### Phase 3: Renderer Virtualization and Event Cleanup

- Virtualize timeline cluster rendering with overscan.
- Convert people/search/detail grids to paged or virtualized rendering.
- Normalize event semantics so one event name maps to one lifecycle meaning.
- Keep browse-mode startup simple and independent from model readiness.

### Phase 4: Worker Reintroduction

- Reintroduce a dedicated worker only after paging/lazy-loading is in place.
- Use an explicit worker protocol:
  - request id
  - command type
  - success/error reply
  - progress events on a dedicated namespace
- Move thumbnail generation, analysis proxies, and AI inference into the worker.
- Add a persistent `index_jobs` table:
  - `index_jobs(id, media_id, stage, status, attempts, priority, last_error, updated_at_ms)`

### Phase 5: Imaging and Packaging

- Replace remaining `nativeImage` decode/resize paths with `sharp`.
- Keep `sharp` memory cache explicitly bounded for the 4 GB baseline.
- Continue using model-on-demand behavior:
  - browsing works without models
  - AI download is optional but encouraged
  - first-run browsing is never blocked on model download
- Trim release artifacts by excluding unnecessary docs, tests, maps, caches, and non-target binaries where safe.

## Acceptance Targets

Phase 1 acceptance targets:

- `2k` images become browsable in `<= 120s` on the 4 GB baseline
- The app remains interactive during indexing
- Peak RAM during Phase 1 first-run indexing stays below `2.2 GB`

## Verification Checklist

- App starts and loads photos whether models are already present or not.
- First import of `2k` images remains responsive on the low-RAM baseline.
- Background AI continues while browsing timeline, people, and detail views.
- People and search still update correctly after background indexing completes.
- Detail view still opens originals in the lightbox.
- Watcher-based refresh still detects changed and deleted files.
