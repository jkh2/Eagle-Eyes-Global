// Wraps GEV's existing, headless-safe USGS earthquake source and analyst
// record mapper — does not re-implement fetch or parsing logic.
//
// Two real things learned reading the upstream source directly (not assumed):
// 1. `createEarthquakesLayer` (src/layers/earthquakes/index.js) requires a
//    live Cesium `viewer` and only exposes `getAnalystRecords()` after
//    `init()`/`enable()`/`update()` have populated its Cesium data source —
//    it is NOT headless-callable. The pure, headless-safe pieces are
//    `createUsgsEarthquakeSource` (source.js) and `mapAnalystRecord`
//    (model.js) directly — this module uses only those two.
// 2. `normalizeEarthquakeSnapshot` (records.js) produces rows with a
//    `depthKm` field; `mapAnalystRecord` expects its raw input under `depth`.
//    Without the rename below, every record's depth silently comes back null.
//
// Revised per Orion Sentinel's independent review, round 1 (2026-09-18):
// observation payload, separate attribution/license, explicit freshness_ms,
// NOT_QUERIED state, input bounds, abort-doesn't-fail-health, post-fetch
// timestamp stamping, last-good-snapshot cache with in-flight dedupe,
// fallback-id disclosure, safe ISO conversion.
//
// Revised again per round 2 (2026-09-18) — three real remaining bugs:
//  1. (package.json/scripts, not this file) false-green test script fixed.
//  2. Cached envelopes were served with their original fetch-time `state`
//     (LIVE) even when actually stale/degraded — every served envelope now
//     gets its `state` recomputed and relabeled (on a clone, never mutating
//     the cache) to reflect what's actually true *now*. Corrected the state
//     mapping itself too: UNAVAILABLE is reserved for "no servable snapshot
//     exists at all" — a failed refresh with a still-existing (if expired)
//     cached snapshot is DEGRADED, not UNAVAILABLE, because there IS usable
//     evidence being served, just not fresh and not currently refreshable.
//  3. maxResults now rejects non-integer/non-positive/NaN input outright
//     (like radius) rather than silently coercing it; oversized valid
//     integers are clamped, not rejected. freshnessMs and the injected
//     clock's output are validated so a misconfiguration can't silently
//     produce an invalid expires_at.
//  Concurrency fix: the shared in-flight fetch is now source-owned (started
//  with no caller's AbortSignal attached to the actual network request), so
//  one caller cancelling their own wait can never cancel another caller's
//  concurrent observation — this was a real cross-tenant cancellation leak
//  in the original in-flight-dedupe design.
import { createUsgsEarthquakeSource } from '../../src/layers/earthquakes/source.js';
import { mapAnalystRecord } from '../../src/layers/earthquakes/model.js';
import {
  SOURCE_STATE,
  buildEnvelope,
  haversineKm,
  safeIso,
} from '../evidenceEnvelope.mjs';

export const SOURCE_ID = 'usgs-earthquakes';

/** USGS's all_day feed is a rolling 24h window with no per-record expiry of
 * its own. This is our adapter's own freshness policy, not an upstream fact —
 * stated explicitly rather than left implicit. Chosen to roughly match the
 * upstream app's own 60s polling interval for this layer, with headroom. */
const DEFAULT_FRESHNESS_MS = 5 * 60 * 1000; // 5 minutes

/** The upstream source silently drops any event below this magnitude. This
 * must be disclosed in every record's limitations — an agent must never read
 * "nothing returned" as "nothing happened" when it might mean "filtered". */
const MAGNITUDE_FLOOR = 2.5;

const BASE_LIMITATIONS = Object.freeze([
  `Only earthquakes of magnitude ${MAGNITUDE_FLOOR}+ are included; smaller events in this area are not represented and their absence does not mean none occurred.`,
  'Source window is a rolling trailing 24 hours (USGS all_day feed); events older than that are not covered by this source at all.',
]);

const FALLBACK_ID_LIMITATION =
  'This record has no native USGS event id and was assigned a snapshot-order fallback id — it is not stable across separate fetches.';

const STALE_SERVED_LIMITATION =
  'This record is being served from a cached snapshot that is no longer within the freshness window.';

const MAX_RADIUS_KM = 500;
const MAX_RESULTS_CAP = 50;

/** The source-owned fetch has no caller signal attached (see the concurrency
 * fix note below) — without its own timeout, a hung USGS request would pin
 * `inFlight` forever and every future caller would join a permanently hung
 * promise. Orion Sentinel's round-3 catch. Confirmed with him that upstream
 * `createUsgsEarthquakeSource().getSnapshot({signal})` already threads a
 * passed signal into `fetch()`, so a source-owned AbortController here needs
 * no upstream change to work. */
const FETCH_TIMEOUT_MS = 10 * 1000;

function assertFiniteInRange(name, value, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a finite number in [${min}, ${max}], got ${value}`);
  }
}

function assertPositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

function makeAbortError() {
  return typeof DOMException !== 'undefined'
    ? new DOMException('The operation was aborted', 'AbortError')
    : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

export function createEarthquakesEvidenceSource({
  fetchImpl,
  freshnessMs = DEFAULT_FRESHNESS_MS,
  clock = () => new Date(),
  fetchTimeoutMs = FETCH_TIMEOUT_MS,
} = {}) {
  assertPositiveInteger('freshnessMs', freshnessMs);
  assertPositiveInteger('fetchTimeoutMs', fetchTimeoutMs);

  const usgs = createUsgsEarthquakeSource(
    fetchImpl ? { fetchImpl } : undefined,
  );

  /** Last successfully retrieved snapshot: { envelopes, retrievedAt: Date } | null */
  let lastGoodSnapshot = null;
  /** Whether the most recent (non-abort) fetch attempt failed. Cleared on
   * every success, set only by a genuine failure — never by cancellation. */
  let lastAttemptFailed = false;
  let lastErrorMessage = null;
  /** The source-owned in-flight fetch, deduplicated across callers. This
   * promise is NEVER tied to any individual caller's AbortSignal — see the
   * concurrency-fix note above. */
  let inFlight = null;

  function now() {
    const d = clock();
    if (!(d instanceof Date) || Number.isNaN(d.getTime()))
      throw new TypeError('createEarthquakesEvidenceSource: injected clock() must return a valid Date');
    return d;
  }

  function buildEnvelopeForRow(row, retrievedAt) {
    const analyst = mapAnalystRecord({
      id: row.usgsId ?? row.stableId,
      mag: row.mag,
      place: row.place,
      time: row.time,
      depth: row.depthKm, // upstream field-name mismatch — see module header
      lat: row.lat,
      lon: row.lon,
    });
    const usedFallbackId = row.usgsId == null;
    const expiresAtMs = retrievedAt.getTime() + freshnessMs;
    return buildEnvelope({
      source: 'USGS Earthquake Hazards Program',
      sourceRecordId: analyst.id,
      observedAt: safeIso(analyst.timeMs), // USGS-sourced value — never trust it's in Date's valid range
      retrievedAt: retrievedAt.toISOString(),
      expiresAt: safeIso(expiresAtMs),
      freshnessMs,
      state: SOURCE_STATE.LIVE, // provisional — relabeled at serve time, see relabelForServing()
      geometry: { lat: analyst.lat, lon: analyst.lon, depthKm: analyst.depthKm },
      attribution: 'U.S. Geological Survey',
      license: 'U.S. public domain',
      limitations: usedFallbackId
        ? [...BASE_LIMITATIONS, FALLBACK_ID_LIMITATION]
        : BASE_LIMITATIONS,
      privacyClass: 'public',
      observation: { kind: 'earthquake', magnitude: analyst.magnitude, place: analyst.place },
    });
  }

  /** Compute the source's real current state — the single source of truth
   * both `getStatus()` and per-envelope relabeling use, so they can never
   * disagree with each other.
   * UNAVAILABLE is reserved for "no servable snapshot exists at all" — a
   * failed refresh with a still-usable (if expired) cached snapshot is
   * DEGRADED, not UNAVAILABLE, because there IS evidence being served. */
  function computeState(nowMs) {
    if (!lastGoodSnapshot) return lastAttemptFailed ? SOURCE_STATE.UNAVAILABLE : SOURCE_STATE.NOT_QUERIED;
    const fresh = nowMs - lastGoodSnapshot.retrievedAt.getTime() <= freshnessMs;
    if (fresh) return SOURCE_STATE.LIVE;
    return lastAttemptFailed ? SOURCE_STATE.DEGRADED : SOURCE_STATE.STALE;
  }

  /** Clone an envelope and stamp it with the real, current state — never
   * trust the state a cached envelope was originally built with, since time
   * has passed and reality may have changed since. */
  function relabelForServing(envelope, currentState) {
    if (envelope.state === currentState) return envelope;
    const limitations =
      currentState === SOURCE_STATE.STALE || currentState === SOURCE_STATE.DEGRADED
        ? [...envelope.limitations, STALE_SERVED_LIMITATION]
        : envelope.limitations;
    return { ...envelope, state: currentState, limitations };
  }

  /** Start (or join) the source-owned fetch. Deliberately does NOT accept an
   * external AbortSignal — the underlying network request belongs to the
   * source, not to any individual caller, so one caller cancelling their own
   * wait can never cancel another caller's concurrent observation. Instead
   * it owns its OWN timeout, so a hung upstream request can't pin `inFlight`
   * forever (Orion Sentinel's round-3 catch). */
  function startOrJoinRefresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), fetchTimeoutMs);
      try {
        const rows = await usgs.getSnapshot({ signal: timeoutController.signal });
        const retrievedAt = now();
        const envelopes = rows.map((row) => buildEnvelopeForRow(row, retrievedAt));
        lastGoodSnapshot = { envelopes, retrievedAt };
        lastAttemptFailed = false;
        lastErrorMessage = null;
        return lastGoodSnapshot;
      } catch (err) {
        lastAttemptFailed = true;
        lastErrorMessage =
          err?.name === 'AbortError'
            ? `USGS request timed out after ${fetchTimeoutMs}ms`
            : err?.message || 'USGS source unavailable';
        throw err;
      } finally {
        clearTimeout(timer);
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /** Await the shared refresh, but let this specific caller bail out early
   * via their own signal without affecting the underlying fetch or any
   * other waiter. */
  function waitForRefresh(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(makeAbortError());
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(makeAbortError());
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }

  /** Return the best available envelopes, each relabeled with the real
   * current state at the moment of serving. Falls back to a cached
   * (possibly expired) snapshot on a failed refresh rather than throwing,
   * as long as something is actually cached. */
  async function getServedEnvelopes({ signal } = {}) {
    signal?.throwIfAborted();
    const nowValue = now();
    const nowMs = nowValue.getTime();
    const fresh = lastGoodSnapshot != null && nowMs - lastGoodSnapshot.retrievedAt.getTime() <= freshnessMs;
    let refreshError = null;
    if (!fresh) {
      try {
        await waitForRefresh(startOrJoinRefresh(), signal);
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        // Genuine failure — fall through to serve whatever is cached, if anything.
        refreshError = err;
      }
    }
    // Nothing servable at all: propagate the real failure rather than
    // silently returning an empty array — the caller (server.mjs) must be
    // able to tell "genuinely zero results" apart from "source is down",
    // and an empty array here would erase that distinction.
    if (!lastGoodSnapshot) {
      if (refreshError) throw refreshError;
      return [];
    }
    const currentState = computeState(now().getTime());
    return lastGoodSnapshot.envelopes.map((env) => relabelForServing(env, currentState));
  }

  return {
    id: SOURCE_ID,
    /** Bounded region query: filters the full snapshot by great-circle
     * distance. USGS itself has no server-side radius filter. Validates and
     * bounds every input rather than trusting the caller. */
    async observeRegion({ centerLat, centerLon, radiusKm, maxResults = MAX_RESULTS_CAP, signal } = {}) {
      assertFiniteInRange('centerLat', centerLat, -90, 90);
      assertFiniteInRange('centerLon', centerLon, -180, 180);
      assertFiniteInRange('radiusKm', radiusKm, Number.EPSILON, MAX_RADIUS_KM);
      assertPositiveInteger('maxResults', maxResults);
      const boundedMaxResults = Math.min(MAX_RESULTS_CAP, maxResults);

      const envelopes = await getServedEnvelopes({ signal });
      const withDistance = envelopes
        .map((env) => ({
          env,
          distanceKm: haversineKm(centerLat, centerLon, env.geometry.lat, env.geometry.lon),
        }))
        .filter((r) => r.distanceKm <= radiusKm)
        .sort((a, b) => a.distanceKm - b.distanceKm);
      return withDistance.slice(0, boundedMaxResults).map((r) => r.env);
    },
    getStatus() {
      const state = computeState(now().getTime());
      return {
        id: SOURCE_ID,
        state,
        last_success_at: lastGoodSnapshot ? lastGoodSnapshot.retrievedAt.toISOString() : null,
        note: lastErrorMessage,
      };
    },
  };
}
