import {
  EVIDENCE_HANDOFF_SCHEMA,
  MAX_EVIDENCE_TOKEN_CHARS,
} from '../src/evidenceHandoffContract.js';

const HANDOFF_SCHEMA = EVIDENCE_HANDOFF_SCHEMA;
export { MAX_EVIDENCE_TOKEN_CHARS };

function assertGlobeOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TypeError('globeOrigin must use http or https');
  }
  if (url.username || url.password) {
    throw new TypeError('globeOrigin must not contain credentials');
  }
  url.search = '';
  url.hash = '';
  return url;
}

/** Encode the exact evidence packet returned by MCP for read-side handoff. */
export function encodeEvidenceHandoff(envelope) {
  const token = Buffer.from(
    JSON.stringify({ schema: HANDOFF_SCHEMA, envelope }),
    'utf8',
  ).toString('base64url');
  if (token.length > MAX_EVIDENCE_TOKEN_CHARS) {
    throw new RangeError(
      'Evidence packet is too large for a bounded globe URL',
    );
  }
  return token;
}

/**
 * Build a camera-only globe URL carrying the exact cached evidence packet.
 * This does not enable a layer or control a running globe; the human chooses
 * whether to open the URL.
 */
export function buildGlobeHandoffUrl(
  envelope,
  globeOrigin = 'http://localhost:4173/',
) {
  const lat = envelope?.geometry?.lat;
  const lon = envelope?.geometry?.lon;
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
    throw new TypeError('Evidence handoff requires a valid latitude');
  }
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) {
    throw new TypeError('Evidence handoff requires a valid longitude');
  }

  const url = assertGlobeOrigin(globeOrigin);
  const params = new URLSearchParams({
    v: '2',
    lat: lat.toFixed(6),
    lon: lon.toFixed(6),
    alt: '80000',
    heading: '0',
    // The hash describes the camera position, not a look-at target. Straight
    // down keeps the packet coordinate on the glass; an oblique pitch places
    // it below the viewport even though the camera is geographically nearby.
    pitch: '-90',
    roll: '0',
    style: 'normal',
    map: 'osm',
    evidence: encodeEvidenceHandoff(envelope),
  });
  url.hash = params.toString();
  return url.href;
}

export { HANDOFF_SCHEMA };
