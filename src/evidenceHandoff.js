import {
  EVIDENCE_HANDOFF_SCHEMA,
  MAX_EVIDENCE_TOKEN_CHARS,
} from './evidenceHandoffContract.js';

export { EVIDENCE_HANDOFF_SCHEMA, MAX_EVIDENCE_TOKEN_CHARS };

const SOURCE_STATES = new Set([
  'NOT_QUERIED',
  'LIVE',
  'STALE',
  'DEGRADED',
  'UNAVAILABLE',
  'KEY_REQUIRED',
  'MODELED',
  'FALLBACK',
]);

function boundedString(value, name, { nullable = false, max = 2_000 } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new TypeError(`Invalid ${name}`);
  }
  return value;
}

function timestamp(value, name, { nullable = false } = {}) {
  const result = boundedString(value, name, { nullable, max: 64 });
  if (result !== null && !Number.isFinite(Date.parse(result))) {
    throw new TypeError(`Invalid ${name}`);
  }
  return result;
}

function validateEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid envelope');
  }
  boundedString(value.source, 'source', { max: 512 });
  boundedString(value.source_record_id, 'source_record_id', { max: 512 });
  timestamp(value.observed_at, 'observed_at', { nullable: true });
  timestamp(value.retrieved_at, 'retrieved_at');
  timestamp(value.expires_at, 'expires_at', { nullable: true });
  if (
    value.freshness_ms !== null &&
    (!Number.isFinite(value.freshness_ms) || value.freshness_ms < 0)
  ) {
    throw new TypeError('Invalid freshness_ms');
  }
  if (!SOURCE_STATES.has(value.state)) throw new TypeError('Invalid state');
  const { geometry } = value;
  if (
    !geometry ||
    typeof geometry !== 'object' ||
    !Number.isFinite(geometry.lat) ||
    Math.abs(geometry.lat) > 90 ||
    !Number.isFinite(geometry.lon) ||
    Math.abs(geometry.lon) > 180
  ) {
    throw new TypeError('Invalid geometry');
  }
  if (
    geometry.bbox !== undefined &&
    (!Array.isArray(geometry.bbox) ||
      geometry.bbox.length !== 4 ||
      geometry.bbox.some((coordinate) => !Number.isFinite(coordinate)) ||
      Math.abs(geometry.bbox[0]) > 180 ||
      Math.abs(geometry.bbox[2]) > 180 ||
      Math.abs(geometry.bbox[1]) > 90 ||
      Math.abs(geometry.bbox[3]) > 90 ||
      geometry.bbox[1] > geometry.bbox[3])
  ) {
    throw new TypeError('Invalid geometry.bbox');
  }
  boundedString(value.attribution, 'attribution');
  boundedString(value.license, 'license');
  boundedString(value.privacy_class, 'privacy_class', { max: 128 });
  if (
    !Array.isArray(value.limitations) ||
    value.limitations.length === 0 ||
    value.limitations.length > 20
  ) {
    throw new TypeError('Invalid limitations');
  }
  value.limitations.forEach((item) =>
    boundedString(item, 'limitation', { max: 1_000 }),
  );
  if (
    !value.observation ||
    typeof value.observation !== 'object' ||
    Array.isArray(value.observation)
  ) {
    throw new TypeError('Invalid observation');
  }
  return value;
}

function decodeBase64UrlUtf8(token) {
  if (!/^[A-Za-z0-9_-]+$/.test(token))
    throw new TypeError('Invalid base64url token');
  const normalized = token.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Decode and validate one bounded snapshot packet without fetching anything. */
export function decodeEvidenceHandoff(token) {
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > MAX_EVIDENCE_TOKEN_CHARS
  ) {
    return { status: 'invalid', envelope: null };
  }
  try {
    const packet = JSON.parse(decodeBase64UrlUtf8(token));
    if (packet?.schema !== EVIDENCE_HANDOFF_SCHEMA)
      throw new TypeError('Unknown schema');
    return { status: 'valid', envelope: validateEnvelope(packet.envelope) };
  } catch {
    return { status: 'invalid', envelope: null };
  }
}

/** Read only the evidence parameter; camera/share parsing remains independent. */
export function parseEvidenceHandoff(hash = window.location.hash) {
  const params = new URLSearchParams(String(hash).replace(/^#/, ''));
  if (!params.has('evidence')) return { status: 'absent', envelope: null };
  return decodeEvidenceHandoff(params.get('evidence'));
}

function firstObservationLabel(observation) {
  const candidate =
    observation.incident_name ?? observation.place ?? observation.name ?? null;
  return typeof candidate === 'string' && candidate.length <= 512
    ? candidate
    : null;
}

export function formatRetrievedAge(retrievedAt, nowMs = Date.now()) {
  const retrievedAtMs = Date.parse(retrievedAt);
  if (!Number.isFinite(retrievedAtMs) || !Number.isFinite(nowMs))
    return 'unknown age';
  const ageMs = nowMs - retrievedAtMs;
  if (ageMs < -60_000) return 'retrieved time is in the future';
  if (ageMs < 60_000) return 'retrieved just now';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `retrieved ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `retrieved ${hours} h ago`;
  return `retrieved ${Math.floor(hours / 24)} d ago`;
}

export function buildEvidenceHandoffView(envelope, nowMs = Date.now()) {
  const expiresAtMs =
    envelope.expires_at === null ? null : Date.parse(envelope.expires_at);
  const observationLabel = firstObservationLabel(envelope.observation);
  const facts = [];
  if (Number.isFinite(envelope.observation.magnitude)) {
    facts.push(`Magnitude ${envelope.observation.magnitude}`);
  }
  if (Number.isFinite(envelope.observation.acres)) {
    facts.push(`${envelope.observation.acres.toLocaleString('en-US')} acres`);
  }
  if (Number.isFinite(envelope.observation.containment_pct)) {
    facts.push(`${envelope.observation.containment_pct}% contained`);
  }
  return {
    title: observationLabel ?? envelope.source_record_id,
    facts,
    expiredNow: expiresAtMs !== null && nowMs > expiresAtMs,
    retrievedAge: formatRetrievedAge(envelope.retrieved_at, nowMs),
    rows: [
      ['Source', envelope.source],
      ['Record', envelope.source_record_id],
      ['Packet state', envelope.state],
      ['Observed', envelope.observed_at ?? 'Unknown'],
      ['Retrieved', envelope.retrieved_at],
      ['Age', formatRetrievedAge(envelope.retrieved_at, nowMs)],
      ['Expires', envelope.expires_at ?? 'No source expiry supplied'],
      [
        'Position',
        `${envelope.geometry.lat.toFixed(6)}, ${envelope.geometry.lon.toFixed(6)}`,
      ],
      ...(Array.isArray(envelope.geometry.bbox)
        ? [['Bounds', envelope.geometry.bbox.join(', ')]]
        : []),
      ['Attribution', envelope.attribution],
      ['License', envelope.license],
    ],
  };
}

function element(documentRef, tag, className, text) {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Mount a visible snapshot card. All untrusted source text uses textContent. */
export function mountEvidenceHandoff({
  documentRef = document,
  hash = window.location.hash,
  nowMs = Date.now(),
  decoded: suppliedDecoded = null,
} = {}) {
  const decoded = suppliedDecoded ?? parseEvidenceHandoff(hash);
  if (decoded.status === 'absent' || !documentRef?.body) return null;

  const card = element(documentRef, 'aside', 'evidence-handoff');
  card.id = 'evidence-handoff';
  card.setAttribute('aria-label', 'Evidence handoff snapshot');
  const close = element(
    documentRef,
    'button',
    'evidence-handoff__close',
    'Close',
  );
  close.type = 'button';
  close.setAttribute('aria-label', 'Close evidence snapshot');
  close.addEventListener('click', () => card.remove());
  card.append(close);

  if (decoded.status === 'invalid') {
    card.className += ' evidence-handoff--invalid';
    card.append(
      element(
        documentRef,
        'div',
        'evidence-handoff__eyebrow',
        'EVIDENCE HANDOFF · INVALID',
      ),
      element(
        documentRef,
        'h2',
        'evidence-handoff__title',
        'Do not rely on this packet',
      ),
      element(
        documentRef,
        'p',
        'evidence-handoff__notice',
        'The snapshot token is malformed, unsupported, or exceeds the safety limit. No evidence was loaded.',
      ),
    );
    documentRef.body.append(card);
    return card;
  }

  const { envelope } = decoded;
  const view = buildEvidenceHandoffView(envelope, nowMs);
  if (view.expiredNow) card.className += ' evidence-handoff--expired';
  card.append(
    element(
      documentRef,
      'div',
      'evidence-handoff__eyebrow',
      'EVIDENCE HANDOFF · UNSIGNED SNAPSHOT — NOT A LIVE LAYER',
    ),
    element(documentRef, 'h2', 'evidence-handoff__title', view.title),
  );
  if (view.facts.length > 0) {
    card.append(
      element(
        documentRef,
        'p',
        'evidence-handoff__facts',
        view.facts.join(' · '),
      ),
    );
  }
  if (view.expiredNow) {
    card.append(
      element(
        documentRef,
        'p',
        'evidence-handoff__notice',
        `NOW EXPIRED — the packet's recorded state remains ${envelope.state}; it has not been refreshed.`,
      ),
    );
  }
  const details = element(documentRef, 'dl', 'evidence-handoff__details');
  for (const [label, value] of view.rows) {
    details.append(
      element(documentRef, 'dt', null, label),
      element(documentRef, 'dd', null, String(value)),
    );
  }
  card.append(
    details,
    element(documentRef, 'h3', 'evidence-handoff__subhead', 'Limitations'),
  );
  const limitations = element(
    documentRef,
    'ul',
    'evidence-handoff__limitations',
  );
  for (const limitation of envelope.limitations) {
    limitations.append(element(documentRef, 'li', null, limitation));
  }
  card.append(
    limitations,
    element(
      documentRef,
      'p',
      'evidence-handoff__footnote',
      'Unsigned — contents are supplied by this link and are not verified by this page. The camera is centered on this packet’s coordinates. Nearby map features are not asserted to be this record.',
    ),
  );
  documentRef.body.append(card);
  return card;
}

export function markEvidenceOverlayUnavailable(card, documentRef = document) {
  if (!card) return;
  card.className += ' evidence-handoff--invalid';
  card.append(
    element(
      documentRef,
      'p',
      'evidence-handoff__notice',
      'MAP FEATURE UNAVAILABLE — the snapshot details remain visible, but the point and bounding box were not added to the globe.',
    ),
  );
}
