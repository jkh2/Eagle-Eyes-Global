// Shared evidence envelope shape for the Alliance geospatial query surface.
// Every non-empty result from every MCP tool in this adapter uses this same
// shape — no tool invents its own record format. See
// plans/gods_eye_alliance_geospatial_plan_2026-09-18.md (SentinelHome) for the
// design this implements, agreed jointly by Claude and Orion Sentinel.
//
// Revised per Orion Sentinel's independent review (2026-09-18): attribution
// and license are separate fields; freshness is explicit, not folded into
// expires_at alone; every envelope carries a source-specific `observation`
// payload (a bare geometry-only record without e.g. an earthquake's
// magnitude is not an observation interface); privacy_class uses "public"
// rather than "none" for a source with no personal data at all.

/** Source freshness/availability state. Never invent a state ad hoc — add it
 * here first so every consumer sees the same vocabulary. NOT_QUERIED is
 * distinct from UNAVAILABLE: the source has simply never been asked yet,
 * which is not the same fact as having been asked and failed. */
export const SOURCE_STATE = Object.freeze({
  NOT_QUERIED: 'NOT_QUERIED',
  LIVE: 'LIVE',
  STALE: 'STALE',
  DEGRADED: 'DEGRADED',
  UNAVAILABLE: 'UNAVAILABLE',
  KEY_REQUIRED: 'KEY_REQUIRED',
  MODELED: 'MODELED',
  FALLBACK: 'FALLBACK',
});

/** Five distinct reasons a query can return nothing — never collapsed into
 * one generic "no data". This is the Eagle Eyes lesson (Poncha Pass): a
 * source that never attempts to observe is a different fact than one that
 * tried and failed. */
export const EMPTY_REASON = Object.freeze({
  OBSERVED_ZERO: 'observed_zero',
  SOURCE_UNAVAILABLE: 'source_unavailable',
  NOT_COVERED: 'not_covered',
  NOT_QUERIED: 'not_queried',
  UPSTREAM_NEVER_ATTEMPTED: 'upstream_never_attempted',
});

const MIN_ISO_MS = -8_640_000_000_000_000;
const MAX_ISO_MS = 8_640_000_000_000_000;

/** Convert a timestamp (ms since epoch, or a Date) to an ISO string, or null
 * if the value is missing, non-finite, or outside the range `Date` can
 * represent — never throws. A `RangeError` from `.toISOString()` on an
 * out-of-range but finite number is exactly the kind of thing that must not
 * crash a query in production. */
export function safeIso(value) {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(ms) || ms < MIN_ISO_MS || ms > MAX_ISO_MS) return null;
  return new Date(ms).toISOString();
}

/**
 * Build one evidence envelope. Every field is required except `expiresAt`
 * and `freshnessMs`, which are null when the caller has no meaningful
 * freshness policy for this source yet (that absence must be visible, not
 * silently omitted).
 * @param {object} input
 * @param {string} input.source - Human-readable source name.
 * @param {string} input.sourceRecordId - Native id from the source, stable.
 * @param {string|null} input.observedAt - ISO-8601 event time, or null if unknown.
 * @param {string} input.retrievedAt - ISO-8601, stamped by the adapter after a successful fetch.
 * @param {string|null} input.expiresAt - ISO-8601 freshness horizon, or null.
 * @param {number|null} input.freshnessMs - The freshness *policy* duration itself, explicit.
 * @param {string} input.state - One of SOURCE_STATE.
 * @param {{lat:number, lon:number, depthKm?:number|null}} input.geometry
 * @param {string} input.attribution
 * @param {string} input.license
 * @param {string[]} input.limitations - Always non-empty; state what this record cannot tell you.
 * @param {string} input.privacyClass - e.g. "public".
 * @param {object} input.observation - Source-specific, JSON-safe facts (e.g. {kind, magnitude, place}).
 * @returns {object}
 */
export function buildEnvelope({
  source,
  sourceRecordId,
  observedAt,
  retrievedAt,
  expiresAt = null,
  freshnessMs = null,
  state,
  geometry,
  attribution,
  license,
  limitations,
  privacyClass,
  observation,
}) {
  if (!source) throw new TypeError('buildEnvelope: source is required');
  if (!sourceRecordId)
    throw new TypeError('buildEnvelope: sourceRecordId is required');
  if (!retrievedAt) throw new TypeError('buildEnvelope: retrievedAt is required');
  if (!Object.values(SOURCE_STATE).includes(state))
    throw new TypeError(`buildEnvelope: unknown state "${state}"`);
  if (!Array.isArray(limitations) || limitations.length === 0)
    throw new TypeError(
      'buildEnvelope: limitations must be a non-empty array — every record must state what it cannot tell you',
    );
  if (
    !geometry ||
    !Number.isFinite(geometry.lat) ||
    Math.abs(geometry.lat) > 90 ||
    !Number.isFinite(geometry.lon) ||
    Math.abs(geometry.lon) > 180
  )
    throw new TypeError('buildEnvelope: geometry.lat/lon must be finite and in-range');
  if (!license) throw new TypeError('buildEnvelope: license is required');
  if (!observation || typeof observation !== 'object')
    throw new TypeError(
      'buildEnvelope: observation is required — a bare geometry with no source-specific facts is not an observation',
    );
  return {
    source,
    source_record_id: String(sourceRecordId),
    observed_at: observedAt ?? null,
    retrieved_at: retrievedAt,
    expires_at: expiresAt,
    freshness_ms: freshnessMs,
    state,
    geometry,
    attribution,
    license,
    limitations,
    privacy_class: privacyClass,
    observation,
  };
}

/** Build the honest-empty response shape a query tool returns when it has
 * zero envelopes to return, always naming which of the five reasons applies. */
export function buildEmptyResult(emptyReason) {
  if (!Object.values(EMPTY_REASON).includes(emptyReason))
    throw new TypeError(`buildEmptyResult: unknown empty reason "${emptyReason}"`);
  return { observations: [], empty_reason: emptyReason };
}

/** Great-circle distance in km (haversine). Used for point/region filtering
 * over sources (like USGS) that return global data with no built-in radius
 * filter of their own. Clamps the intermediate term to [0,1] — floating
 * point can push it fractionally past 1 for near-antipodal or
 * near-identical points, which makes `Math.asin` return NaN. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.min(
    1,
    Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2,
  );
  return 2 * R * Math.asin(Math.sqrt(a));
}
