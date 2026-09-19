import assert from 'node:assert/strict';
import test from 'node:test';
import { createEarthquakesEvidenceSource } from './earthquakes.mjs';
import { SOURCE_STATE } from '../evidenceEnvelope.mjs';

function fakeUsgsFeed(features) {
  return async () => ({
    ok: true,
    json: async () => ({ type: 'FeatureCollection', features }),
  });
}

function feature({ id, lon, lat, depth, mag, place, time }) {
  return {
    id,
    geometry: { type: 'Point', coordinates: [lon, lat, depth] },
    properties: { mag, place, time },
  };
}

/** A controllable fake clock: starts at `startMs`, advances only when told. */
function fakeClock(startMs) {
  let now = startMs;
  const clock = () => new Date(now);
  clock.advance = (ms) => {
    now += ms;
  };
  return clock;
}

test('maps a real USGS feature into a correctly-shaped evidence envelope, depth field renamed correctly, observation payload present', async () => {
  const src = createEarthquakesEvidenceSource({
    fetchImpl: fakeUsgsFeed([
      feature({ id: 'us7000abcd', lon: -105.5, lat: 37.3, depth: 12.4, mag: 3.2, place: '10km NW of Alamosa, CO', time: 1_000_000 }),
    ]),
  });
  const envelopes = await src.observeRegion({ centerLat: 37.3, centerLon: -105.5, radiusKm: 10 });
  assert.equal(envelopes.length, 1);
  const env = envelopes[0];
  assert.equal(env.source, 'USGS Earthquake Hazards Program');
  assert.equal(env.source_record_id, 'us7000abcd');
  assert.equal(env.state, SOURCE_STATE.LIVE);
  assert.equal(env.geometry.lat, 37.3);
  assert.equal(env.geometry.lon, -105.5);
  // The real bug this guards against: depthKm -> depth field rename.
  assert.equal(env.geometry.depthKm, 12.4);
  assert.equal(env.observed_at, new Date(1_000_000).toISOString());
  // The real bug Orion caught: magnitude/place must survive into the envelope.
  assert.deepEqual(env.observation, { kind: 'earthquake', magnitude: 3.2, place: '10km NW of Alamosa, CO' });
  assert.equal(env.attribution, 'U.S. Geological Survey');
  assert.equal(env.license, 'U.S. public domain');
  assert.equal(env.privacy_class, 'public');
  assert.ok(env.freshness_ms > 0);
  assert.ok(env.limitations.some((l) => l.includes('2.5')));
  assert.ok(env.expires_at);
  // No native id was omitted here, so the fallback-id caveat must NOT appear.
  assert.ok(!env.limitations.some((l) => l.includes('fallback id')));
});

test('a real magnitude-2.5+ event that upstream omits its own id for gets the fallback-id limitation disclosed', async () => {
  const src = createEarthquakesEvidenceSource({
    fetchImpl: fakeUsgsFeed([
      feature({ id: null, lon: 0, lat: 0, depth: 1, mag: 4.0, place: 'Fixture', time: 1 }),
    ]),
  });
  const envelopes = await src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 });
  assert.equal(envelopes.length, 1);
  assert.ok(envelopes[0].limitations.some((l) => l.includes('fallback id')));
});

test('observeRegion filters by great-circle distance, excludes out-of-range events, sorts nearest-first', async () => {
  const src = createEarthquakesEvidenceSource({
    fetchImpl: fakeUsgsFeed([
      feature({ id: 'far-in-range', lon: -105.0, lat: 37.3, depth: 5, mag: 3.0, place: 'Farther but in range', time: 1 }),
      feature({ id: 'near', lon: -105.5, lat: 37.31, depth: 5, mag: 3.0, place: 'Nearest', time: 2 }),
      feature({ id: 'far', lon: 139.7, lat: 35.7, depth: 5, mag: 5.0, place: 'Tokyo, Japan', time: 3 }),
    ]),
  });
  const nearby = await src.observeRegion({ centerLat: 37.3, centerLon: -105.5, radiusKm: 100 });
  assert.equal(nearby.length, 2);
  assert.equal(nearby[0].source_record_id, 'near'); // nearest first
  assert.equal(nearby[1].source_record_id, 'far-in-range');
});

test('observeRegion rejects invalid/out-of-range spatial input rather than producing surprising results', async () => {
  const src = createEarthquakesEvidenceSource({ fetchImpl: fakeUsgsFeed([]) });
  await assert.rejects(() => src.observeRegion({ centerLat: 999, centerLon: 0, radiusKm: 10 }), RangeError);
  await assert.rejects(() => src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: -5 }), RangeError);
  await assert.rejects(() => src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: NaN }), RangeError);
  await assert.rejects(() => src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 5000 }), RangeError); // exceeds 500km cap
});

test('observeRegion caps maxResults at the documented ceiling regardless of what the caller requests', async () => {
  const features = Array.from({ length: 60 }, (_, i) =>
    feature({ id: `q${i}`, lon: 0, lat: 0, depth: 1, mag: 3, place: `Fixture ${i}`, time: i }),
  );
  const src = createEarthquakesEvidenceSource({ fetchImpl: fakeUsgsFeed(features) });
  const results = await src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10, maxResults: 10_000 });
  assert.equal(results.length, 50); // MAX_RESULTS_CAP, not the caller's oversized request
});

test('getStatus reports NOT_QUERIED (not UNAVAILABLE) before any query has ever been made', async () => {
  const src = createEarthquakesEvidenceSource({
    fetchImpl: fakeUsgsFeed([feature({ id: 'a', lon: 0, lat: 0, depth: 1, mag: 3, place: 'X', time: 1 })]),
  });
  assert.equal(src.getStatus().state, SOURCE_STATE.NOT_QUERIED);
});

test('getStatus transitions NOT_QUERIED -> LIVE -> STALE as the fake clock advances past the freshness window', async () => {
  const clock = fakeClock(1_000_000);
  const src = createEarthquakesEvidenceSource({
    fetchImpl: fakeUsgsFeed([feature({ id: 'a', lon: 0, lat: 0, depth: 1, mag: 3, place: 'X', time: 1 })]),
    freshnessMs: 1000,
    clock,
  });
  assert.equal(src.getStatus().state, SOURCE_STATE.NOT_QUERIED);
  await src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 });
  assert.equal(src.getStatus().state, SOURCE_STATE.LIVE);
  clock.advance(5000); // past the 1000ms freshness window
  assert.equal(src.getStatus().state, SOURCE_STATE.STALE);
});

test('a genuine fetch failure after a prior success reports DEGRADED (not UNAVAILABLE) while a stale-but-usable snapshot is still being served', async () => {
  // Corrected per Orion's round-2 review: UNAVAILABLE is reserved for "no
  // servable snapshot exists at all" — a failed refresh with a still-usable
  // (if expired) cached snapshot is DEGRADED, because real evidence IS
  // being served, just not fresh and not currently refreshable.
  const clock = fakeClock(1_000_000);
  let shouldFail = false;
  const src = createEarthquakesEvidenceSource({
    fetchImpl: async () => {
      if (shouldFail) throw new Error('network down');
      return { ok: true, json: async () => ({ type: 'FeatureCollection', features: [feature({ id: 'a', lon: 0, lat: 0, depth: 1, mag: 3, place: 'X', time: 1 })] }) };
    },
    freshnessMs: 1000,
    clock,
  });
  await src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 });
  assert.equal(src.getStatus().state, SOURCE_STATE.LIVE);

  shouldFail = true;
  clock.advance(2000); // snapshot now stale, forcing observeRegion to attempt (and fail) a refresh
  const results = await src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 });
  // Falls back to serving the last-good (now stale) snapshot rather than throwing.
  assert.equal(results.length, 1);
  assert.equal(src.getStatus().state, SOURCE_STATE.DEGRADED);
  assert.ok(src.getStatus().note);
  // The real bug from round 1: the served RECORD itself must reflect
  // DEGRADED too, not the LIVE state it was originally built with.
  assert.equal(results[0].state, SOURCE_STATE.DEGRADED);
  assert.ok(results[0].limitations.some((l) => l.includes('cached snapshot')));
});

test('getStatus reports UNAVAILABLE only when there is truly nothing servable — never-succeeded plus a failed attempt', async () => {
  const src = createEarthquakesEvidenceSource({ fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(() => src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 }));
  const status = src.getStatus();
  assert.equal(status.state, SOURCE_STATE.UNAVAILABLE);
  assert.ok(status.note);
});

test("one caller cancelling their own wait does not cancel a concurrent caller's observation — the real cross-tenant cancellation bug", async () => {
  // Round-1 design bug: the shared in-flight fetch was tied to whichever
  // caller's signal started it, so caller A aborting could invisibly cancel
  // caller B's concurrent, unrelated request. The fetch is now source-owned;
  // only the caller who actually asked to cancel is affected.
  const abortA = new AbortController();
  let resolveFetch;
  const src = createEarthquakesEvidenceSource({
    fetchImpl: () =>
      new Promise((resolve) => {
        resolveFetch = () =>
          resolve({
            ok: true,
            json: async () => ({
              type: 'FeatureCollection',
              features: [feature({ id: 'a', lon: 0, lat: 0, depth: 1, mag: 3, place: 'X', time: 1 })],
            }),
          });
      }),
  });

  const callA = src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10, signal: abortA.signal });
  const callB = src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 }); // no signal — must not be affected by A's cancellation

  abortA.abort();
  resolveFetch(); // the underlying (source-owned) fetch completes regardless of A's cancellation

  await assert.rejects(() => callA, { name: 'AbortError' });
  const resultB = await callB;
  assert.equal(resultB.length, 1); // B got its real result, unaffected by A's cancellation
  assert.equal(src.getStatus().state, SOURCE_STATE.LIVE); // the shared fetch succeeded; A's cancellation didn't poison it
});

test('a signal already aborted before the call starts rejects immediately with AbortError', async () => {
  const src = createEarthquakesEvidenceSource({ fetchImpl: fakeUsgsFeed([]) });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    () => src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10, signal: abort.signal }),
    { name: 'AbortError' },
  );
});

test('observeRegion rejects invalid maxResults (zero, negative, NaN, non-integer) rather than silently coercing it', async () => {
  const src = createEarthquakesEvidenceSource({ fetchImpl: fakeUsgsFeed([]) });
  await assert.rejects(() => src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10, maxResults: 0 }), RangeError);
  await assert.rejects(() => src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10, maxResults: -5 }), RangeError);
  await assert.rejects(() => src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10, maxResults: NaN }), RangeError);
  await assert.rejects(() => src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10, maxResults: 3.5 }), RangeError);
});

test('construction rejects an invalid freshnessMs (so a misconfiguration cannot silently produce a broken expires_at)', () => {
  assert.throws(() => createEarthquakesEvidenceSource({ freshnessMs: 0 }), RangeError);
  assert.throws(() => createEarthquakesEvidenceSource({ freshnessMs: -1 }), RangeError);
  assert.throws(() => createEarthquakesEvidenceSource({ freshnessMs: NaN }), RangeError);
});

test('a hung upstream request times out rather than pinning the source forever (Orion Sentinel round-3 catch)', async () => {
  const src = createEarthquakesEvidenceSource({
    // Simulates a real fetch() that hangs until its AbortSignal fires — my
    // first version of this test used a plain never-settling Promise that
    // ignored the signal entirely, which made the test itself hang forever
    // rather than proving anything. A real fetch DOES reject on abort;
    // this fake must too, or it isn't testing the real contract.
    fetchImpl: (url, { signal } = {}) =>
      new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
    fetchTimeoutMs: 20,
  });
  await assert.rejects(
    () => src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 }),
    { name: 'AbortError' },
  );
  const status = src.getStatus();
  assert.equal(status.state, SOURCE_STATE.UNAVAILABLE);
  assert.match(status.note, /timed out/);
  // The critical assertion: a SECOND call must not still be stuck behind the
  // first hung request — inFlight must have been released, not pinned forever.
  const results = await src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 }).catch((e) => e);
  assert.ok(results instanceof Error); // still fails (fetchImpl never resolves), but it actually ran again rather than hanging
});

test('an injected clock that returns an invalid Date throws clearly rather than propagating an Invalid Date', async () => {
  const src = createEarthquakesEvidenceSource({
    fetchImpl: fakeUsgsFeed([feature({ id: 'a', lon: 0, lat: 0, depth: 1, mag: 3, place: 'X', time: 1 })]),
    clock: () => new Date(NaN),
  });
  await assert.rejects(() => src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 }), TypeError);
});


test('a magnitude-filtered snapshot (real M2.4 event, below the upstream 2.5 floor) resolves to zero envelopes, not a crash', async () => {
  // normalizeEarthquakeSnapshot (upstream) drops sub-2.5 events before this
  // module ever sees them — pass a REAL below-floor feature through the
  // fake fetch to exercise that actual filter, not an already-empty array.
  const src = createEarthquakesEvidenceSource({
    fetchImpl: fakeUsgsFeed([
      feature({ id: 'too-small', lon: 0, lat: 0, depth: 1, mag: 2.4, place: 'Fixture', time: 1 }),
    ]),
  });
  const envelopes = await src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 });
  assert.deepEqual(envelopes, []);
});

test('an out-of-Date-range USGS timestamp does not crash the request — observed_at falls back to null', async () => {
  const src = createEarthquakesEvidenceSource({
    fetchImpl: fakeUsgsFeed([
      // Larger than Date can represent (max ~8.64e15ms from epoch).
      feature({ id: 'weird-time', lon: 0, lat: 0, depth: 1, mag: 3, place: 'Fixture', time: 9e15 }),
    ]),
  });
  const envelopes = await src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 });
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].observed_at, null);
});

test('concurrent observeRegion calls before any snapshot exists dedupe onto one fetch', async () => {
  let fetchCount = 0;
  const src = createEarthquakesEvidenceSource({
    fetchImpl: async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true, json: async () => ({ features: [] }) };
    },
  });
  await Promise.all([
    src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 }),
    src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 }),
    src.observeRegion({ centerLat: 0, centerLon: 0, radiusKm: 10 }),
  ]);
  assert.equal(fetchCount, 1);
});
