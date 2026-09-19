// Phase 2 evidence source: wildfires, merging NASA EONET (world layer, curated
// events) with NIFC WFIGS Current Interagency Fire Perimeters (US ground
// truth for shape/acres/containment). Spec: Grok Sentinel, posted in full on
// jkh2/alliance-wire issue #1 (2026-09-18), implemented here directly against
// that spec, with two real corrections found by inspecting live API
// responses rather than assuming field names from documentation:
//
// 1. Upstream GEV has NO existing EONET or WFIGS fetch/parse code to wrap —
//    it only has NASA FIRMS (a different system: satellite hotspot
//    detection, no incident-level metadata). Grok's spec assumed a
//    wrap-only path ("do not invent a third HTTP client"); that path isn't
//    available for these two specific APIs, so this module is new fetch
//    logic, following the same headless/isomorphic-fetch shape as
//    earthquakes/source.js rather than a fourth pattern.
// 2. The merge key is NOT the IRWIN GUID (`attr_IrwinID`, e.g.
//    "{E4ADFECB-21C8-4240-BE50-3920090FF77C}") as Grok's spec first assumed.
//    A live WFIGS record was pulled and inspected directly: it carries
//    `attr_UniqueFireIdentifier` (e.g. "2026-UTNWS-200030"), and a live
//    EONET wildfire event's `sources[].url` (when source id is "IRWIN")
//    embeds that exact same human-readable identifier format in its path
//    (e.g. ".../incidents/2026-TXTXS-268653"). That is the real, working
//    join key between the two feeds — the GUID never appears in EONET at
//    all. Falls back to Grok's own name+day+10km proximity key when no
//    unique fire identifier can be extracted from either side.
import {
  SOURCE_STATE,
  buildEnvelope,
  haversineKm,
  safeIso,
} from '../evidenceEnvelope.mjs';

export const SOURCE_ID = 'fires';

const EONET_BASE_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events';
const WFIGS_BASE_URL =
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query';
const WFIGS_OUT_FIELDS =
  'attr_IncidentName,attr_IrwinID,attr_IncidentTypeCategory,attr_PercentContained,' +
  'attr_UniqueFireIdentifier,poly_GISAcres,poly_DateCurrent,attr_FireDiscoveryDateTime';
const EONET_RESULT_LIMIT = 10_000;
const WFIGS_RESULT_LIMIT = 1_000;

const DEFAULT_FRESHNESS_MS = 5 * 60 * 1000; // matches WFIGS's own ~5 min refresh cadence
const WFIGS_LIVE_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h — Grok's spec
const WFIGS_STALE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h — beyond this, still-fixtured records are STALE
// Found by live testing (2026-09-18), not assumed: 10s was too tight for a
// real combined EONET+WFIGS round trip under real network conditions (the
// WFIGS query alone can return ~1000 records with ~15 fields each) — the
// timeout was firing legitimately but too early through the full server
// stack, even though an isolated single-source test with a longer override
// completed in ~6.6s. 20s gives real headroom while staying well under the
// MCP client's own 60s default per-request timeout.
const FETCH_TIMEOUT_MS = 20 * 1000;
const MAX_RADIUS_KM = 500;
const MAX_RESULTS_CAP = 50;
const FALLBACK_TIME_WINDOW_MS = 72 * 60 * 60 * 1000;

const EONET_ONLY_LIMITATION =
  'This event has no matching authoritative WFIGS perimeter — acreage, containment, and fire type are not confirmed.';
const UNIQUE_ID_FALLBACK_LIMITATION =
  'Merged by approximate name/date/proximity, not a shared unique fire identifier — this pairing is a best-effort match, not a confirmed one.';
const EONET_DISCLAIMER_LIMITATION =
  'NASA EONET metadata is for visualization and general information; spatial and temporal extents may be approximate and are not official.';

function buildEonetUrl(limit) {
  const url = new URL(EONET_BASE_URL);
  url.searchParams.set('category', 'wildfires');
  url.searchParams.set('status', 'open');
  url.searchParams.set('limit', String(limit));
  return url.href;
}

function buildWfigsUrl(limit) {
  const url = new URL(WFIGS_BASE_URL);
  url.searchParams.set('where', '1=1');
  url.searchParams.set('outFields', WFIGS_OUT_FIELDS);
  url.searchParams.set('f', 'geojson');
  url.searchParams.set('resultRecordCount', String(limit));
  return url.href;
}

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

/** Extract the human-readable unique fire identifier (e.g. "2026-TXTXS-268653")
 * from an EONET wildfire event's IRWIN source URL, if present. Returns null
 * if the event has no IRWIN-attributed source or the URL doesn't match the
 * expected shape — never guesses. */
function extractUniqueFireId(eonetEvent) {
  const irwinSource = (eonetEvent.sources || []).find((s) => s.id === 'IRWIN');
  if (!irwinSource?.url) return null;
  const match = /\/incidents\/([0-9]{4}-[A-Z0-9]+-[0-9]+)/.exec(irwinSource.url);
  return match ? match[1] : null;
}

function normalizeEonetEvent(event) {
  const latestGeometry = (event.geometry || []).at(-1);
  if (!latestGeometry || latestGeometry.type !== 'Point') return null;
  const [lon, lat] = latestGeometry.coordinates;
  if (
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90 ||
    !Number.isFinite(lon) ||
    lon < -180 ||
    lon > 180
  )
    return null;
  return {
    eonetId: event.id,
    uniqueFireId: extractUniqueFireId(event),
    title: typeof event.title === 'string' ? event.title : null,
    fireType:
      typeof event.title === 'string' && /\b(rx|prescribed)\b/i.test(event.title)
        ? 'RX'
        : 'unknown',
    lat,
    lon,
    acresFromEonet:
      latestGeometry.magnitudeUnit === 'acres' && Number.isFinite(latestGeometry.magnitudeValue)
        ? latestGeometry.magnitudeValue
        : null,
    observedAtIso: typeof latestGeometry.date === 'string' ? latestGeometry.date : null,
    sourceUrl: (event.sources || []).find((s) => s.url)?.url ?? null,
  };
}

/** Flatten every ring of a Polygon or MultiPolygon into one list of [lon,lat]
 * pairs — a real fire perimeter is routinely a MultiPolygon or a Polygon
 * with several disjoint rings (separate burning patches under one incident
 * record), and only using the first ring would silently ignore the rest. */
function flattenAllCoordinatePairs(geometry) {
  const pairs = [];
  const walk = (node, depth) => {
    if (depth === 0 && Array.isArray(node) && typeof node[0] === 'number') {
      pairs.push(node);
      return;
    }
    if (Array.isArray(node)) for (const child of node) walk(child, depth - 1);
  };
  // Polygon coordinates nest 3 deep to a point ([[[lon,lat],...]]); MultiPolygon nests 4 deep.
  walk(geometry.coordinates, geometry.type === 'MultiPolygon' ? 3 : 2);
  return pairs;
}

function normalizeWfigsFeature(feature) {
  const props = feature?.properties;
  const geometry = feature?.geometry;
  if (!props || !geometry) return null;
  // A real fire perimeter can have thousands of vertices across many rings
  // (found live: one query returned a 14MB response because the raw polygon
  // was embedded whole in every envelope — an agent needs facts, not GIS
  // geometry). This computes a centroid AND a bounded bbox (always exactly
  // 4 numbers) across every ring, and the full polygon is never carried
  // into the envelope at all.
  const allPoints = flattenAllCoordinatePairs(geometry);
  if (allPoints.length === 0) return null;
  const lats = allPoints.map(([, y]) => y);
  const lons = allPoints.map(([x]) => x);
  const lat = lats.reduce((sum, y) => sum + y, 0) / lats.length;
  const lon = lons.reduce((sum, x) => sum + x, 0) / lons.length;
  if (
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90 ||
    !Number.isFinite(lon) ||
    lon < -180 ||
    lon > 180
  )
    return null;
  const bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  const fireType = ['WF', 'RX', 'CX'].includes(props.attr_IncidentTypeCategory)
    ? props.attr_IncidentTypeCategory
    : 'unknown';
  return {
    uniqueFireId: props.attr_UniqueFireIdentifier ?? null,
    irwinId: props.attr_IrwinID ?? null,
    incidentName: props.attr_IncidentName ?? null,
    acres: Number.isFinite(props.poly_GISAcres) ? props.poly_GISAcres : null,
    containmentPct: Number.isFinite(props.attr_PercentContained) ? props.attr_PercentContained : null,
    fireType,
    lat,
    lon,
    bbox,
    updatedAtMs: Number.isFinite(props.poly_DateCurrent) ? props.poly_DateCurrent : null,
    discoveredAtMs: Number.isFinite(props.attr_FireDiscoveryDateTime)
      ? props.attr_FireDiscoveryDateTime
      : null,
  };
}

/** Merge normalized EONET and WFIGS rows by identity. Grok's key, corrected
 * against real data (see module header): unique fire identifier first, then
 * a name+date+10km proximity fallback — never treated as confirmed. */
function mergeFireRecords(eonetRows, wfigsRows) {
  const wfigsByUniqueId = new Map();
  for (const row of wfigsRows) if (row.uniqueFireId) wfigsByUniqueId.set(row.uniqueFireId, row);

  const merged = [];
  const consumedWfigs = new Set();

  for (const eo of eonetRows) {
    let match = eo.uniqueFireId ? wfigsByUniqueId.get(eo.uniqueFireId) : null;
    let matchedByFallback = false;
    if (!match) {
      // Fallback: same approximate reporting window + within 10km + roughly
      // matching name token. Identity is never inferred from name and place
      // alone: recurring fires routinely reuse geographic names across years.
      match = wfigsRows.find((wf) => {
        if (consumedWfigs.has(wf)) return false;
        if (!eo.title || !wf.incidentName) return false;
        const nameToken = wf.incidentName.toLowerCase().split(/\s+/)[0];
        const eonetTimeMs = Date.parse(eo.observedAtIso);
        const wfigsTimes = [wf.updatedAtMs, wf.discoveredAtMs].filter(Number.isFinite);
        const temporallyPlausible =
          Number.isFinite(eonetTimeMs) &&
          wfigsTimes.some(
            (wfigsTimeMs) =>
              Math.abs(eonetTimeMs - wfigsTimeMs) <= FALLBACK_TIME_WINDOW_MS,
          );
        return (
          nameToken.length > 2 &&
          eo.title.toLowerCase().includes(nameToken) &&
          temporallyPlausible &&
          haversineKm(eo.lat, eo.lon, wf.lat, wf.lon) <= 10
        );
      });
      if (match) matchedByFallback = true;
    }
    if (match) consumedWfigs.add(match);
    merged.push({ eonet: eo, wfigs: match ?? null, matchedByFallback });
  }
  for (const wf of wfigsRows) {
    if (!consumedWfigs.has(wf)) merged.push({ eonet: null, wfigs: wf, matchedByFallback: false });
  }
  return merged;
}

export function createFiresEvidenceSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  freshnessMs = DEFAULT_FRESHNESS_MS,
  clock = () => new Date(),
  fetchTimeoutMs = FETCH_TIMEOUT_MS,
  eonetResultLimit = EONET_RESULT_LIMIT,
  wfigsResultLimit = WFIGS_RESULT_LIMIT,
} = {}) {
  assertPositiveInteger('freshnessMs', freshnessMs);
  assertPositiveInteger('fetchTimeoutMs', fetchTimeoutMs);
  assertPositiveInteger('eonetResultLimit', eonetResultLimit);
  assertPositiveInteger('wfigsResultLimit', wfigsResultLimit);

  let lastGoodSnapshot = null; // { merged: [...], retrievedAt: Date }
  let lastAttemptFailed = false;
  let lastErrorMessage = null;
  let inFlight = null;

  function now() {
    const d = clock();
    if (!(d instanceof Date) || Number.isNaN(d.getTime()))
      throw new TypeError('createFiresEvidenceSource: injected clock() must return a valid Date');
    return d;
  }

  async function fetchJson(url, signal) {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) throw new Error(`Upstream HTTP ${response.status} for ${url}`);
    return response.json();
  }

  function startOrJoinRefresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), fetchTimeoutMs);
      try {
        const [eonetJson, wfigsJson] = await Promise.all([
          fetchJson(buildEonetUrl(eonetResultLimit), timeoutController.signal),
          fetchJson(buildWfigsUrl(wfigsResultLimit), timeoutController.signal),
        ]);
        if (!Array.isArray(eonetJson.events)) {
          throw new TypeError('EONET response did not contain an events array');
        }
        if (!Array.isArray(wfigsJson.features)) {
          throw new TypeError('WFIGS response did not contain a features array');
        }
        if (eonetJson.events.length >= eonetResultLimit) {
          throw new Error(
            `EONET reached the configured ${eonetResultLimit}-event limit; completeness cannot be guaranteed`,
          );
        }
        if (
          wfigsJson.exceededTransferLimit === true ||
          wfigsJson.features.length >= wfigsResultLimit
        ) {
          throw new Error(
            `WFIGS reached the configured ${wfigsResultLimit}-feature limit; completeness cannot be guaranteed`,
          );
        }
        const eonetRows = eonetJson.events
          .map(normalizeEonetEvent)
          .filter(Boolean);
        const wfigsRows = wfigsJson.features
          .map(normalizeWfigsFeature)
          .filter(Boolean);
        const omittedEonetCount = eonetJson.events.length - eonetRows.length;
        const omittedWfigsCount = wfigsJson.features.length - wfigsRows.length;
        const normalizationLimitations = [];
        if (omittedEonetCount > 0) {
          normalizationLimitations.push(
            `${omittedEonetCount} EONET record(s) were omitted because their geometry was unsupported, invalid, or out of range.`,
          );
        }
        if (omittedWfigsCount > 0) {
          normalizationLimitations.push(
            `${omittedWfigsCount} WFIGS record(s) were omitted because their geometry or required fields were unusable.`,
          );
        }
        const merged = mergeFireRecords(eonetRows, wfigsRows);
        const retrievedAt = now();
        lastGoodSnapshot = {
          merged,
          retrievedAt,
          normalizationLimitations,
          dataNote:
            normalizationLimitations.length > 0
              ? normalizationLimitations.join(' ')
              : null,
        };
        lastAttemptFailed = false;
        lastErrorMessage = null;
        return lastGoodSnapshot;
      } catch (err) {
        lastAttemptFailed = true;
        lastErrorMessage =
          err?.name === 'AbortError'
            ? `Fires upstream request timed out after ${fetchTimeoutMs}ms`
            : err?.message || 'Fires upstream unavailable';
        throw err;
      } finally {
        clearTimeout(timer);
        inFlight = null;
      }
    })();
    return inFlight;
  }

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

  function computeState(nowMs) {
    if (!lastGoodSnapshot) return lastAttemptFailed ? SOURCE_STATE.UNAVAILABLE : SOURCE_STATE.NOT_QUERIED;
    const fresh = nowMs - lastGoodSnapshot.retrievedAt.getTime() <= freshnessMs;
    if (fresh) return SOURCE_STATE.LIVE;
    return lastAttemptFailed ? SOURCE_STATE.DEGRADED : SOURCE_STATE.STALE;
  }

  function envelopeForMergedRecord(
    record,
    retrievedAt,
    overallState,
    normalizationLimitations = [],
  ) {
    const { eonet, wfigs, matchedByFallback } = record;
    const sourceRecordId = wfigs?.uniqueFireId ?? wfigs?.irwinId ?? eonet?.eonetId;
    if (!sourceRecordId) return null;

    const lat = wfigs?.lat ?? eonet?.lat;
    const lon = wfigs?.lon ?? eonet?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const limitations = [...normalizationLimitations];
    let recordState = overallState;

    if (eonet) limitations.push(EONET_DISCLAIMER_LIMITATION);

    if (wfigs && !eonet) {
      // WFIGS-only: authoritative perimeter data with no EONET corroboration
      // — still real, still usable, not degraded on that basis alone.
    } else if (eonet && !wfigs) {
      const eonetObservedMs = Date.parse(eonet.observedAtIso);
      const eonetAgeMs = Number.isFinite(eonetObservedMs)
        ? retrievedAt.getTime() - eonetObservedMs
        : null;
      recordState =
        eonetAgeMs != null && eonetAgeMs > WFIGS_STALE_WINDOW_MS
          ? SOURCE_STATE.STALE
          : SOURCE_STATE.DEGRADED;
      limitations.push(EONET_ONLY_LIMITATION);
      if (recordState === SOURCE_STATE.STALE) {
        limitations.push('EONET event geometry has not been updated in over 24 hours.');
      }
    } else if (matchedByFallback) {
      limitations.push(UNIQUE_ID_FALLBACK_LIMITATION);
    }

    if (wfigs?.updatedAtMs != null) {
      const ageMs = retrievedAt.getTime() - wfigs.updatedAtMs;
      if (ageMs > WFIGS_STALE_WINDOW_MS && recordState === SOURCE_STATE.LIVE) {
        recordState = SOURCE_STATE.STALE;
        limitations.push('WFIGS perimeter has not been updated in over 24 hours.');
      } else if (ageMs > WFIGS_LIVE_WINDOW_MS && recordState === SOURCE_STATE.LIVE) {
        recordState = SOURCE_STATE.STALE;
      }
    }

    if (
      wfigs &&
      !limitations.some((limitation) =>
        limitation.startsWith('WFIGS perimeter has not been updated'),
      )
    ) {
      limitations.push(
        'Acreage and containment reflect the most recent WFIGS update, which may lag real fire conditions by minutes to hours.',
      );
    }

    const fireType = wfigs?.fireType ?? eonet?.fireType ?? 'unknown';
    // A bounded [minLon, minLat, maxLon, maxLat] box, never the raw polygon —
    // a real WFIGS perimeter can carry thousands of vertices across many
    // rings; embedding that whole shape in every envelope produced a 14MB
    // response for a single query in live testing. An agent needs "roughly
    // how big and where," not GIS-grade geometry.
    const geometry = { lat, lon };
    if (wfigs?.bbox) geometry.bbox = wfigs.bbox;

    return buildEnvelope({
      source: eonet && wfigs ? 'NASA EONET + NIFC WFIGS' : eonet ? 'NASA EONET' : 'NIFC WFIGS',
      sourceRecordId: String(sourceRecordId),
      observedAt: safeIso(wfigs?.discoveredAtMs) ?? eonet?.observedAtIso ?? null,
      retrievedAt: retrievedAt.toISOString(),
      expiresAt: safeIso(retrievedAt.getTime() + freshnessMs),
      freshnessMs,
      state: recordState,
      geometry,
      attribution:
        eonet && wfigs
          ? 'NASA EONET (eonet.gsfc.nasa.gov); NIFC WFIGS (public domain)'
          : eonet
            ? 'NASA EONET (eonet.gsfc.nasa.gov)'
            : 'NIFC WFIGS (public domain)',
      license:
        eonet && wfigs
          ? 'NIFC WFIGS: U.S. public domain; NASA EONET metadata: see the EONET disclaimer and linked-source terms'
          : eonet
            ? 'NASA EONET metadata: see the EONET disclaimer and linked-source terms'
            : 'U.S. public domain',
      limitations,
      privacyClass: 'public',
      observation: {
        kind: 'wildfire',
        incident_name: wfigs?.incidentName ?? eonet?.title ?? null,
        irwin_id: wfigs?.irwinId ?? null,
        eonet_id: eonet?.eonetId ?? null,
        acres: wfigs?.acres ?? eonet?.acresFromEonet ?? null,
        containment_pct: wfigs?.containmentPct ?? null,
        fire_type: fireType,
        behavior: null, // neither upstream source supplies this — never fabricated
        source_urls: [eonet?.sourceUrl].filter(Boolean),
      },
    });
  }

  async function getServedEnvelopes({ signal, includePrescribed } = {}) {
    signal?.throwIfAborted();
    const nowMs = now().getTime();
    const fresh = lastGoodSnapshot != null && nowMs - lastGoodSnapshot.retrievedAt.getTime() <= freshnessMs;
    if (!fresh) {
      try {
        await waitForRefresh(startOrJoinRefresh(), signal);
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        // fall through to serve cached data if any exists
      }
    }
    if (!lastGoodSnapshot) {
      if (lastAttemptFailed) throw new Error(lastErrorMessage || 'Fires upstream unavailable');
      return [];
    }
    const state = computeState(now().getTime());
    const retrievedAt = lastGoodSnapshot.retrievedAt;
    const envelopes = lastGoodSnapshot.merged
      .map((r) =>
        envelopeForMergedRecord(
          r,
          retrievedAt,
          state,
          lastGoodSnapshot.normalizationLimitations,
        ),
      )
      .filter(Boolean)
      .filter((env) => includePrescribed || env.observation.fire_type !== 'RX');
    return envelopes;
  }

  return {
    id: SOURCE_ID,
    async observeRegion({
      centerLat,
      centerLon,
      radiusKm,
      maxResults = MAX_RESULTS_CAP,
      minAcres = 0,
      includePrescribed = false,
      signal,
    } = {}) {
      assertFiniteInRange('centerLat', centerLat, -90, 90);
      assertFiniteInRange('centerLon', centerLon, -180, 180);
      assertFiniteInRange('radiusKm', radiusKm, Number.EPSILON, MAX_RADIUS_KM);
      assertPositiveInteger('maxResults', maxResults);
      if (!Number.isFinite(minAcres) || minAcres < 0) {
        throw new RangeError(`minAcres must be a finite number >= 0, got ${minAcres}`);
      }
      const boundedMaxResults = Math.min(MAX_RESULTS_CAP, maxResults);

      const envelopes = await getServedEnvelopes({ signal, includePrescribed });
      const withDistance = envelopes
        .map((env) => ({
          env,
          distanceKm: haversineKm(centerLat, centerLon, env.geometry.lat, env.geometry.lon),
        }))
        .filter((r) => r.distanceKm <= radiusKm)
        .filter((r) => (r.env.observation.acres ?? 0) >= minAcres)
        .sort((a, b) => a.distanceKm - b.distanceKm);
      return withDistance.slice(0, boundedMaxResults).map((r) => r.env);
    },
    getStatus() {
      return {
        id: SOURCE_ID,
        state: computeState(now().getTime()),
        last_success_at: lastGoodSnapshot ? lastGoodSnapshot.retrievedAt.toISOString() : null,
        note: lastErrorMessage ?? lastGoodSnapshot?.dataNote ?? null,
      };
    },
  };
}
