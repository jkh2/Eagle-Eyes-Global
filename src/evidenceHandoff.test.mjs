import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEvidenceHandoffView,
  decodeEvidenceHandoff,
  EVIDENCE_HANDOFF_SCHEMA,
  MAX_EVIDENCE_TOKEN_CHARS,
  formatRetrievedAge,
  mountEvidenceHandoff,
  parseEvidenceHandoff,
} from './evidenceHandoff.js';

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
      bbox: [-120, 37, -119, 38],
    },
    attribution: 'NASA EONET; NIFC WFIGS',
    license: 'Public source terms apply',
    limitations: ['Snapshot only.'],
    privacy_class: 'public',
    observation: {
      kind: 'wildfire',
      incident_name: 'DOME',
      acres: 2335.26,
      containment_pct: 15,
    },
    ...overrides,
  };
}

function tokenFor(value) {
  return Buffer.from(
    JSON.stringify({ schema: EVIDENCE_HANDOFF_SCHEMA, envelope: value }),
    'utf8',
  ).toString('base64url');
}

class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attributes = new Map();
    this.textContent = '';
    this.className = '';
    this.removed = false;
  }
  append(...children) {
    this.children.push(...children);
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  addEventListener(name, callback) {
    this[`${name}Handler`] = callback;
  }
  remove() {
    this.removed = true;
  }
  set innerHTML(_value) {
    throw new Error('innerHTML must never be used');
  }
}

function fakeDocument() {
  const body = new FakeElement('body');
  return { body, createElement: (tag) => new FakeElement(tag) };
}

function allText(node) {
  return [
    node.textContent,
    ...node.children.flatMap((child) => allText(child)),
  ].join(' ');
}

test('decodes the exact versioned envelope and treats a missing token separately', () => {
  const original = envelope();
  assert.deepEqual(decodeEvidenceHandoff(tokenFor(original)), {
    status: 'valid',
    envelope: original,
  });
  assert.deepEqual(parseEvidenceHandoff('#lat=1&lon=2'), {
    status: 'absent',
    envelope: null,
  });
});

test('rejects malformed, unsupported, oversized, and structurally invalid packets', () => {
  assert.equal(decodeEvidenceHandoff('not!base64').status, 'invalid');
  assert.equal(
    decodeEvidenceHandoff('x'.repeat(MAX_EVIDENCE_TOKEN_CHARS + 1)).status,
    'invalid',
  );
  const wrongSchema = Buffer.from(
    JSON.stringify({ schema: 'future', envelope: envelope() }),
  ).toString('base64url');
  assert.equal(decodeEvidenceHandoff(wrongSchema).status, 'invalid');
  assert.equal(
    decodeEvidenceHandoff(
      tokenFor(envelope({ geometry: { lat: 999, lon: 0 } })),
    ).status,
    'invalid',
  );
});

test('expiration is a separate present-time fact and never rewrites the packet state', () => {
  const view = buildEvidenceHandoffView(
    envelope(),
    Date.parse('2026-09-19T17:00:00.000Z'),
  );
  assert.equal(view.expiredNow, true);
  assert.equal(view.retrievedAge, 'retrieved 21 min ago');
  assert.deepEqual(
    view.rows.find(([label]) => label === 'Packet state'),
    ['Packet state', 'LIVE'],
  );
});

test('retrieved age is always explicit, including packets without an expiry', () => {
  const noExpiry = envelope({ expires_at: null });
  const now = Date.parse('2026-09-19T18:38:55.775Z');
  assert.equal(
    formatRetrievedAge(noExpiry.retrieved_at, now),
    'retrieved 2 h ago',
  );
  assert.equal(buildEvidenceHandoffView(noExpiry, now).expiredNow, false);
  assert.deepEqual(
    buildEvidenceHandoffView(noExpiry, now).rows.find(
      ([label]) => label === 'Age',
    ),
    ['Age', 'retrieved 2 h ago'],
  );
});

test('mounts source text only as textContent and labels the card as a non-live snapshot', () => {
  const documentRef = fakeDocument();
  const malicious = envelope({
    observation: { incident_name: '<img src=x onerror=alert(1)>' },
  });
  const card = mountEvidenceHandoff({
    documentRef,
    hash: `#lat=1&lon=2&evidence=${tokenFor(malicious)}`,
    nowMs: Date.parse('2026-09-19T16:40:00.000Z'),
  });
  const text = allText(card);
  assert.match(text, /UNSIGNED SNAPSHOT — NOT A LIVE LAYER/);
  assert.match(text, /<img src=x onerror=alert\(1\)>/);
  assert.match(text, /Nearby map features are not asserted to be this record/);
  assert.match(text, /contents are supplied by this link and are not verified/);
});

test('renders an invalid packet as an explicit do-not-rely warning', () => {
  const documentRef = fakeDocument();
  const card = mountEvidenceHandoff({ documentRef, hash: '#evidence=broken!' });
  assert.match(allText(card), /Do not rely on this packet/);
  assert.match(card.className, /evidence-handoff--invalid/);
});
