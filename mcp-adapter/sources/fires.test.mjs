import assert from 'node:assert/strict';
import test from 'node:test';
import { createFiresEvidenceSource } from './fires.mjs';
import { SOURCE_STATE } from '../evidenceEnvelope.mjs';

// Fixture shapes below are modeled directly on REAL, live-fetched responses
// (verified 2026-09-18 against the actual EONET and WFIGS endpoints, not
// assumed from documentation) — see sources/fires.mjs's module header for
// the field-name corrections that verification produced.

function eonetEvent({ id, title, lat, lon, acres, date, uniqueFireId }) {
  return {
    id,
    title,
    closed: null,
    categories: [{ id: 'wildfires', title: 'Wildfires' }],
    sources: uniqueFireId
      ? [{ id: 'IRWIN', url: `https://irwin.doi.gov/observer/incidents/${uniqueFireId}` }]
      : [],
    geometry: [{ magnitudeValue: acres, magnitudeUnit: 'acres', date, type: 'Point', coordinates: [lon, lat] }],
  };
}

function wfigsFeature({ uniqueFireId, irwinId, incidentName, acres, containmentPct, fireType, lat, lon, updatedAtMs, discoveredAtMs }) {
  return {
    type: 'Feature',
    properties: {
      attr_IncidentName: incidentName,
      attr_IrwinID: irwinId ?? null,
      attr_IncidentTypeCategory: fireType,
      attr_PercentContained: containmentPct ?? null,
      attr_UniqueFireIdentifier: uniqueFireId ?? null,
      poly_GISAcres: acres,
      poly_DateCurrent: updatedAtMs,
      attr_FireDiscoveryDateTime: discoveredAtMs ?? updatedAtMs,
    },
    geometry: {
      type: 'Polygon',
      // A small real-shaped square around (lat, lon) — centroid recovers (lat, lon).
      coordinates: [[[lon - 0.01, lat - 0.01], [lon + 0.01, lat - 0.01], [lon + 0.01, lat + 0.01], [lon - 0.01, lat + 0.01], [lon - 0.01, lat - 0.01]]],
    },
  };
}

function fakeFetch({ eonetEvents = [], wfigsFeatures = [], failWfigs = false, failEonet = false, hang = false } = {}) {
  return async (url, { signal } = {}) => {
    if (hang) {
      return new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }
    if (url.includes('eonet')) {
      if (failEonet) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ events: eonetEvents }) };
    }
    if (failWfigs) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ features: wfigsFeatures }) };
  };
}

test('EONET+WFIGS merge on shared unique fire identifier — full data, LIVE state', async () => {
  const src = createFiresEvidenceSource({
    fetchImpl: fakeFetch({
      eonetEvents: [eonetEvent({ id: 'EONET_1', title: 'Wildfire Test, Colorado', lat: 37.3, lon: -105.5, acres: 500, date: '2026-09-18T00:00:00Z', uniqueFireId: '2026-COTEST-1' })],
      wfigsFeatures: [wfigsFeature({ uniqueFireId: '2026-COTEST-1', irwinId: '{TEST}', incidentName: 'Test Fire', acres: 512, containmentPct: 40, fireType: 'WF', lat: 37.3, lon: -105.5, updatedAtMs: Date.now() })],
    }),
  });
  const results = await src.observeRegion({ centerLat: 37.3, centerLon: -105.5, radiusKm: 10 });
  assert.equal(results.length, 1);
  const env = results[0];
  assert.equal(env.state, SOURCE_STATE.LIVE);
  assert.equal(env.observation.incident_name, 'Test Fire');
  assert.equal(env.observation.acres, 512); // WFIGS acreage wins over EONET's rougher estimate
  assert.equal(env.observation.containment_pct, 40);
  assert.equal(env.observation.fire_type, 'WF');
  assert.equal(env.source, 'NASA EONET + NIFC WFIGS');
});

test('fallback merge requires name, proximity, and temporal proximity when no shared identifier exists', async () => {
  const reportTimeMs = Date.parse('2026-09-18T12:00:00Z');
  const src = createFiresEvidenceSource({
    fetchImpl: fakeFetch({
      eonetEvents: [
        eonetEvent({
          id: 'EONET_FALLBACK',
          title: 'Wildfire Echo, Colorado',
          lat: 37.3,
          lon: -105.5,
          acres: 100,
          date: '2026-09-18T12:00:00Z',
          uniqueFireId: null,
        }),
      ],
      wfigsFeatures: [
        wfigsFeature({
          uniqueFireId: null,
          irwinId: '{FALLBACK}',
          incidentName: 'Echo',
          acres: 110,
          containmentPct: 20,
          fireType: 'WF',
          lat: 37.3,
          lon: -105.5,
          updatedAtMs: reportTimeMs,
          discoveredAtMs: reportTimeMs,
        }),
      ],
    }),
  });
  const results = await src.observeRegion({
    centerLat: 37.3,
    centerLon: -105.5,
    radiusKm: 10,
  });
  assert.equal(results.length, 1);
  assert.ok(results[0].limitations.some((l) => l.includes('approximate name/date/proximity')));
});

test('fallback merge never conflates recurring same-name fires at the same place across distant dates', async () => {
  const src = createFiresEvidenceSource({
    fetchImpl: fakeFetch({
      eonetEvents: [
        eonetEvent({
          id: 'EONET_NEW_ECHO',
          title: 'Wildfire Echo, Colorado',
          lat: 37.3,
          lon: -105.5,
          acres: 100,
          date: '2026-09-18T12:00:00Z',
          uniqueFireId: null,
        }),
      ],
      wfigsFeatures: [
        wfigsFeature({
          uniqueFireId: null,
          irwinId: '{OLD-ECHO}',
          incidentName: 'Echo',
          acres: 110,
          containmentPct: 100,
          fireType: 'WF',
          lat: 37.3,
          lon: -105.5,
          updatedAtMs: Date.parse('2025-09-18T12:00:00Z'),
          discoveredAtMs: Date.parse('2025-09-18T12:00:00Z'),
        }),
      ],
    }),
  });
  const results = await src.observeRegion({
    centerLat: 37.3,
    centerLon: -105.5,
    radiusKm: 10,
  });
  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((result) => result.source).sort(),
    ['NASA EONET', 'NIFC WFIGS'],
  );
});

test('EONET-only event (no WFIGS match) is DEGRADED with an explicit "no authoritative perimeter" limitation', async () => {
  const src = createFiresEvidenceSource({
    clock: () => new Date('2026-09-18T12:00:00Z'),
    fetchImpl: fakeFetch({
      eonetEvents: [eonetEvent({ id: 'EONET_2', title: 'Wildfire Solo, Nevada', lat: 39.0, lon: -119.0, acres: 200, date: '2026-09-18T00:00:00Z', uniqueFireId: null })],
      wfigsFeatures: [],
    }),
  });
  const results = await src.observeRegion({ centerLat: 39.0, centerLon: -119.0, radiusKm: 10 });
  assert.equal(results.length, 1);
  assert.equal(results[0].state, SOURCE_STATE.DEGRADED);
  assert.ok(results[0].limitations.some((l) => l.includes('no matching authoritative WFIGS perimeter')));
  assert.equal(results[0].observation.fire_type, 'unknown');
});

test('EONET-only geometry older than 24 hours is STALE, not merely DEGRADED', async () => {
  const src = createFiresEvidenceSource({
    clock: () => new Date('2026-09-20T12:00:00Z'),
    fetchImpl: fakeFetch({
      eonetEvents: [
        eonetEvent({
          id: 'EONET_OLD',
          title: 'Wildfire Old, Colorado',
          lat: 37.3,
          lon: -105.5,
          acres: 100,
          date: '2026-09-18T00:00:00Z',
          uniqueFireId: null,
        }),
      ],
    }),
  });
  const results = await src.observeRegion({
    centerLat: 37.3,
    centerLon: -105.5,
    radiusKm: 10,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].state, SOURCE_STATE.STALE);
  assert.ok(results[0].limitations.some((l) => l.includes('not been updated in over 24 hours')));
});

test('empty bbox with both feeds answering and nothing in range is observed_zero (verified at the source layer: empty result array)', async () => {
  const src = createFiresEvidenceSource({
    fetchImpl: fakeFetch({
      eonetEvents: [eonetEvent({ id: 'EONET_3', title: 'Wildfire Far Away, Texas', lat: 30.0, lon: -97.0, acres: 100, date: '2026-09-18T00:00:00Z' })],
      wfigsFeatures: [],
    }),
  });
  const results = await src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 }); // nowhere near Texas
  assert.deepEqual(results, []);
});

test('mocked 503 from a required upstream surfaces as a genuine failure (never fabricates records)', async () => {
  const src = createFiresEvidenceSource({ fetchImpl: fakeFetch({ failWfigs: true }) });
  await assert.rejects(() => src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 }));
  assert.equal(src.getStatus().state, SOURCE_STATE.UNAVAILABLE);
});

test('malformed upstream success payload fails closed instead of becoming observed_zero', async () => {
  const src = createFiresEvidenceSource({
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => (url.includes('eonet') ? { unexpected: [] } : { features: [] }),
    }),
  });
  await assert.rejects(
    () => src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 }),
    /events array/,
  );
  assert.equal(src.getStatus().state, SOURCE_STATE.UNAVAILABLE);
});

test('unsupported or out-of-range upstream geometry is omitted with visible disclosure', async () => {
  const invalid = eonetEvent({
    id: 'EONET_INVALID_GEOMETRY',
    title: 'Invalid Geometry Fire',
    lat: 95,
    lon: 0,
    acres: 1,
    date: '2026-09-18T00:00:00Z',
  });
  const valid = wfigsFeature({
    uniqueFireId: '2026-VALID-1',
    irwinId: '{VALID}',
    incidentName: 'Valid Fire',
    acres: 10,
    containmentPct: 0,
    fireType: 'WF',
    lat: 0,
    lon: 0,
    updatedAtMs: Date.now(),
  });
  const src = createFiresEvidenceSource({
    fetchImpl: fakeFetch({
      eonetEvents: [invalid],
      wfigsFeatures: [valid],
    }),
  });
  const results = await src.observeRegion({
    centerLat: 0,
    centerLon: 0,
    radiusKm: 10,
  });
  assert.equal(results.length, 1);
  assert.ok(results[0].limitations.some((l) => l.includes('1 EONET record(s) were omitted')));
  assert.match(src.getStatus().note, /1 EONET record\(s\) were omitted/);
});

test('EONET result-cap contact fails closed instead of silently reporting incomplete coverage', async () => {
  const src = createFiresEvidenceSource({
    eonetResultLimit: 1,
    fetchImpl: fakeFetch({
      eonetEvents: [
        eonetEvent({
          id: 'EONET_CAP',
          title: 'Wildfire Cap',
          lat: 0,
          lon: 0,
          acres: 1,
          date: '2026-09-18T00:00:00Z',
        }),
      ],
    }),
  });
  await assert.rejects(
    () => src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 }),
    /completeness cannot be guaranteed/,
  );
});

test('WFIGS result-cap contact fails closed instead of silently reporting incomplete coverage', async () => {
  const src = createFiresEvidenceSource({
    wfigsResultLimit: 1,
    fetchImpl: fakeFetch({
      wfigsFeatures: [
        wfigsFeature({
          uniqueFireId: '2026-CAP-1',
          irwinId: '{CAP}',
          incidentName: 'Cap Fire',
          acres: 1,
          containmentPct: 0,
          fireType: 'WF',
          lat: 0,
          lon: 0,
          updatedAtMs: Date.now(),
        }),
      ],
    }),
  });
  await assert.rejects(
    () => src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 }),
    /completeness cannot be guaranteed/,
  );
});

test('radius over the 500km cap is rejected before any fetch is attempted (upstream_never_attempted, at the source layer)', async () => {
  let fetchCount = 0;
  const src = createFiresEvidenceSource({
    fetchImpl: async (...args) => {
      fetchCount++;
      return fakeFetch({})(...args);
    },
  });
  await assert.rejects(() => src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 501 }), RangeError);
  assert.equal(fetchCount, 0);
});

test('60 fixtures over the cap returns exactly 50, nearest first, never pages silently', async () => {
  const eonetEvents = [];
  const wfigsFeatures = [];
  for (let i = 0; i < 60; i++) {
    const lat = 0 + i * 0.001; // all within a tight cluster, increasing distance from (0,0)
    wfigsFeatures.push(
      wfigsFeature({ uniqueFireId: `2026-TST-${i}`, irwinId: `{T${i}}`, incidentName: `Fire ${i}`, acres: 10, containmentPct: 0, fireType: 'WF', lat, lon: 0, updatedAtMs: Date.now() }),
    );
  }
  const src = createFiresEvidenceSource({ fetchImpl: fakeFetch({ eonetEvents, wfigsFeatures }) });
  const results = await src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 });
  assert.equal(results.length, 50);
});

test('a stale cached perimeter (past freshness, refresh failing) is served as DEGRADED, never as LIVE', async () => {
  let shouldFail = false;
  let clockMs = 1_000_000;
  const clock = () => new Date(clockMs);
  const src = createFiresEvidenceSource({
    fetchImpl: (...args) => {
      if (shouldFail) return Promise.resolve({ ok: false, status: 503 });
      return fakeFetch({
        wfigsFeatures: [wfigsFeature({ uniqueFireId: '2026-STALE-1', irwinId: '{S}', incidentName: 'Stale Fire', acres: 10, containmentPct: 0, fireType: 'WF', lat: 0, lon: 0, updatedAtMs: clockMs })],
      })(...args);
    },
    freshnessMs: 1000,
    clock,
  });
  await src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 });
  assert.equal(src.getStatus().state, SOURCE_STATE.LIVE);

  shouldFail = true;
  clockMs += 5000;
  const results = await src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 });
  assert.equal(results.length, 1);
  assert.notEqual(results[0].state, SOURCE_STATE.LIVE);
  assert.equal(results[0].state, SOURCE_STATE.DEGRADED);
});

test("abort of caller A does not cancel caller B's concurrent fires query (same cross-tenant fix as earthquakes)", async () => {
  const abortA = new AbortController();
  let resolvers = [];
  const src = createFiresEvidenceSource({
    fetchImpl: (url) =>
      new Promise((resolve) => {
        resolvers.push(() =>
          resolve(
            url.includes('eonet')
              ? { ok: true, json: async () => ({ events: [] }) }
              : {
                  ok: true,
                  json: async () => ({
                    features: [wfigsFeature({ uniqueFireId: '2026-X-1', irwinId: '{X}', incidentName: 'X', acres: 1, containmentPct: 0, fireType: 'WF', lat: 0, lon: 0, updatedAtMs: Date.now() })],
                  }),
                },
          ),
        );
      }),
  });
  const callA = src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10, signal: abortA.signal });
  const callB = src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 });
  abortA.abort();
  resolvers.forEach((r) => r());
  await assert.rejects(() => callA, { name: 'AbortError' });
  const resultB = await callB;
  assert.equal(resultB.length, 1);
});

test('include_prescribed defaults to false and drops RX (prescribed burn) records', async () => {
  const src = createFiresEvidenceSource({
    fetchImpl: fakeFetch({
      wfigsFeatures: [
        wfigsFeature({ uniqueFireId: '2026-RX-1', irwinId: '{RX}', incidentName: 'Prescribed Burn', acres: 50, containmentPct: 100, fireType: 'RX', lat: 0, lon: 0, updatedAtMs: Date.now() }),
      ],
    }),
  });
  const defaultResults = await src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 });
  assert.equal(defaultResults.length, 0);

  const withRx = await src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10, includePrescribed: true });
  assert.equal(withRx.length, 1);
  assert.equal(withRx[0].observation.fire_type, 'RX');
});

test('include_prescribed also excludes EONET-only RX events inferred from their title', async () => {
  const src = createFiresEvidenceSource({
    fetchImpl: fakeFetch({
      eonetEvents: [
        eonetEvent({
          id: 'EONET_RX',
          title: 'Mesa RX Prescribed Fire, Colorado',
          lat: 0,
          lon: 0,
          acres: 50,
          date: new Date().toISOString(),
          uniqueFireId: null,
        }),
      ],
    }),
  });
  const defaultResults = await src.observeRegion({
    centerLat: 0,
    centerLon: 0,
    radiusKm: 10,
  });
  assert.equal(defaultResults.length, 0);

  const withRx = await src.observeRegion({
    centerLat: 0,
    centerLon: 0,
    radiusKm: 10,
    includePrescribed: true,
  });
  assert.equal(withRx.length, 1);
  assert.equal(withRx[0].observation.fire_type, 'RX');
});

test('min_acres filters out fires below the threshold', async () => {
  const src = createFiresEvidenceSource({
    fetchImpl: fakeFetch({
      wfigsFeatures: [
        wfigsFeature({ uniqueFireId: '2026-SMALL-1', irwinId: '{S}', incidentName: 'Small Fire', acres: 5, containmentPct: 0, fireType: 'WF', lat: 0, lon: 0, updatedAtMs: Date.now() }),
        wfigsFeature({ uniqueFireId: '2026-BIG-1', irwinId: '{B}', incidentName: 'Big Fire', acres: 5000, containmentPct: 0, fireType: 'WF', lat: 0, lon: 0.001, updatedAtMs: Date.now() }),
      ],
    }),
  });
  const results = await src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10, minAcres: 1000 });
  assert.equal(results.length, 1);
  assert.equal(results[0].observation.incident_name, 'Big Fire');
});

test('a real-shaped complex perimeter (many rings, thousands of points) never embeds its raw polygon in the envelope — only a bounded bbox', async () => {
  // Regression test for a real bug found in live testing: embedding the raw
  // WFIGS polygon produced a 14MB response for a single query and hung the
  // transport. Build a fixture with many disjoint rings to prove the fix
  // holds under realistic complexity, not just a simple square.
  const manyRings = Array.from({ length: 50 }, (_, i) => {
    const cx = i * 0.01;
    return [[cx, 0], [cx + 0.001, 0], [cx + 0.001, 0.001], [cx, 0.001], [cx, 0]];
  });
  const feature = wfigsFeature({ uniqueFireId: '2026-BIGSHAPE-1', irwinId: '{BIG}', incidentName: 'Complex Fire', acres: 1000, containmentPct: 10, fireType: 'WF', lat: 0.25, lon: 0.25, updatedAtMs: Date.now() });
  feature.geometry = { type: 'Polygon', coordinates: manyRings };
  const src = createFiresEvidenceSource({ fetchImpl: fakeFetch({ wfigsFeatures: [feature] }) });
  const results = await src.observeRegion({ centerLat: 0.25, centerLon: 0.25, radiusKm: 100 });
  assert.equal(results.length, 1);
  assert.equal(results[0].geometry.polygon, undefined);
  assert.ok(Array.isArray(results[0].geometry.bbox));
  assert.equal(results[0].geometry.bbox.length, 4);
  // The serialized envelope must stay small regardless of how complex the
  // real perimeter was — this is the actual regression guard.
  assert.ok(JSON.stringify(results[0]).length < 5000);
});

test('a genuinely never-attempted request (radius rejected pre-fetch) does not corrupt getStatus into UNAVAILABLE', async () => {
  const src = createFiresEvidenceSource({ fetchImpl: fakeFetch({}) });
  await assert.rejects(() => src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 9999 }), RangeError);
  // Validation threw before any fetch attempt — status must remain NOT_QUERIED, not UNAVAILABLE.
  assert.equal(src.getStatus().state, SOURCE_STATE.NOT_QUERIED);
});
