import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGlobeHandoffUrl,
  encodeEvidenceHandoff,
  HANDOFF_SCHEMA,
  MAX_EVIDENCE_TOKEN_CHARS,
} from './evidenceHandoff.mjs';

function envelope(overrides = {}) {
  return {
    source: 'NASA EONET + NIFC WFIGS',
    source_record_id: '2026-CAYNP-000100',
    observed_at: '2026-09-19T16:00:00.000Z',
    retrieved_at: '2026-09-19T16:38:55.775Z',
    expires_at: '2026-09-19T16:53:55.775Z',
    freshness_ms: 900_000,
    state: 'LIVE',
    geometry: {
      lat: 37.5992068751971,
      lon: -119.60739222710066,
      bbox: [-119.7, 37.5, -119.5, 37.7],
    },
    attribution: 'NASA EONET; NIFC WFIGS',
    license: 'Public source terms apply',
    limitations: ['Snapshot evidence, not a live browser layer.'],
    privacy_class: 'public',
    observation: { kind: 'wildfire', incident_name: 'DOME' },
    ...overrides,
  };
}

test('encodes the exact envelope in the versioned handoff packet', () => {
  const original = envelope();
  const token = encodeEvidenceHandoff(original);
  const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  assert.equal(decoded.schema, HANDOFF_SCHEMA);
  assert.deepEqual(decoded.envelope, original);
});

test('builds a bounded human-opened URL centered on the envelope coordinates', () => {
  const original = envelope();
  const result = new URL(
    buildGlobeHandoffUrl(
      original,
      'https://eagle.example/globe?discard=yes#old',
    ),
  );
  const params = new URLSearchParams(result.hash.slice(1));
  assert.equal(result.origin, 'https://eagle.example');
  assert.equal(result.pathname, '/globe');
  assert.equal(result.search, '');
  assert.equal(params.get('lat'), '37.599207');
  assert.equal(params.get('lon'), '-119.607392');
  assert.equal(params.get('pitch'), '-90');
  assert.deepEqual(
    JSON.parse(
      Buffer.from(params.get('evidence'), 'base64url').toString('utf8'),
    ).envelope,
    original,
  );
});

test('rejects unsafe origins, invalid coordinates, and oversized packets', () => {
  assert.throws(
    () => buildGlobeHandoffUrl(envelope(), 'file:///tmp/eagle'),
    /http or https/,
  );
  assert.throws(
    () => buildGlobeHandoffUrl(envelope(), 'https://user:secret@example.test/'),
    /credentials/,
  );
  assert.throws(
    () => buildGlobeHandoffUrl(envelope({ geometry: { lat: 91, lon: 0 } })),
    /latitude/,
  );
  assert.throws(
    () =>
      encodeEvidenceHandoff(
        envelope({
          observation: { note: 'x'.repeat(MAX_EVIDENCE_TOKEN_CHARS) },
        }),
      ),
    /too large/,
  );
});
