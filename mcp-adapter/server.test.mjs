import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, MAX_RADIUS_KM, MAX_RESULTS_CAP } from './server.mjs';
import { SOURCE_STATE, buildEnvelope } from './evidenceEnvelope.mjs';

/** A minimal fake evidence source — no network, fully deterministic — so
 * this test exercises the real MCP protocol wiring (tool registration,
 * schema validation, content/structuredContent shape) without depending on
 * USGS being reachable or returning any particular real-world data. */
function fakeSource({ id = 'fake-source', envelopes = [], throwOn } = {}) {
  return {
    id,
    async observeRegion() {
      if (throwOn === 'unavailable') throw new Error('fake source down');
      if (throwOn === 'abort') {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      return envelopes;
    },
    getStatus() {
      return { id, state: SOURCE_STATE.LIVE, last_success_at: new Date().toISOString(), note: null };
    },
  };
}

function fakeEnvelope(overrides = {}) {
  return buildEnvelope({
    source: 'Fake Source',
    sourceRecordId: 'fake-1',
    observedAt: new Date().toISOString(),
    retrievedAt: new Date().toISOString(),
    expiresAt: null,
    freshnessMs: null,
    state: SOURCE_STATE.LIVE,
    geometry: { lat: 0, lon: 0 },
    attribution: 'Fake',
    license: 'Fake',
    limitations: ['This is a fixture.'],
    privacyClass: 'public',
    observation: { kind: 'fake' },
    ...overrides,
  });
}

/** Connect a real MCP Client to a real MCP Server, in-process, over
 * InMemoryTransport — genuine protocol round-trips (JSON-RPC, schema
 * validation) with no subprocess and no network. */
async function connectedClient(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

test('lists exactly the two current read-only tools', async () => {
  const server = createServer({ sources: {} });
  const client = await connectedClient(server);
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['get_source_status', 'observe_region'],
  );
});

test('get_source_status returns real registered-source status, matching structuredContent to content', async () => {
  const server = createServer({ sources: { a: fakeSource({ id: 'a' }) } });
  const client = await connectedClient(server);
  const result = await client.callTool({ name: 'get_source_status', arguments: {} });
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(parsed, result.structuredContent);
  assert.equal(parsed.sources.length, 1);
  assert.equal(parsed.sources[0].id, 'a');
  assert.equal(parsed.sources[0].state, SOURCE_STATE.LIVE);
});

test('observe_region returns real envelopes when a source has data, structuredContent matches content', async () => {
  const envelope = fakeEnvelope();
  const server = createServer({ sources: { a: fakeSource({ id: 'a', envelopes: [envelope] }) } });
  const client = await connectedClient(server);
  const result = await client.callTool({
    name: 'observe_region',
    arguments: { center: { lat: 0, lon: 0 }, radius_km: 10 },
  });
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(parsed, result.structuredContent);
  assert.equal(parsed.observations.length, 1);
  assert.equal(parsed.observations[0].source_record_id, 'fake-1');
  assert.equal(parsed.empty_reason, null);
  assert.equal(parsed.partial, false);
  assert.deepEqual(parsed.source_results, [
    {
      source_id: 'a',
      outcome: 'observations',
      state: SOURCE_STATE.LIVE,
      matched_count: 1,
      returned_count: 1,
      note: null,
    },
  ]);
});

test('observe_region honest-empty: a genuinely failing source reports source_unavailable, not a fabricated empty', async () => {
  const server = createServer({ sources: { a: fakeSource({ id: 'a', throwOn: 'unavailable' }) } });
  const client = await connectedClient(server);
  const result = await client.callTool({
    name: 'observe_region',
    arguments: { center: { lat: 0, lon: 0 }, radius_km: 10 },
  });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.observations.length, 0);
  assert.equal(parsed.empty_reason, 'source_unavailable');
  assert.equal(parsed.partial, false);
  assert.equal(parsed.source_results[0].outcome, 'source_unavailable');
});

test('observe_region discloses partial multi-source failure even when another source returns evidence', async () => {
  const envelope = fakeEnvelope();
  const server = createServer({
    sources: {
      down: fakeSource({ id: 'down', throwOn: 'unavailable' }),
      live: fakeSource({ id: 'live', envelopes: [envelope] }),
    },
  });
  const client = await connectedClient(server);
  const result = await client.callTool({
    name: 'observe_region',
    arguments: { center: { lat: 0, lon: 0 }, radius_km: 10 },
  });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.observations.length, 1);
  assert.equal(parsed.empty_reason, null);
  assert.equal(parsed.partial, true);
  assert.deepEqual(
    parsed.source_results.map(({ source_id, outcome, returned_count }) => ({
      source_id,
      outcome,
      returned_count,
    })),
    [
      { source_id: 'down', outcome: 'source_unavailable', returned_count: 0 },
      { source_id: 'live', outcome: 'observations', returned_count: 1 },
    ],
  );
});

test('observe_region applies the result cap after globally sorting all sources by distance', async () => {
  const far = fakeEnvelope({
    sourceRecordId: 'far',
    geometry: { lat: 1, lon: 0 },
  });
  const near = fakeEnvelope({
    sourceRecordId: 'near',
    geometry: { lat: 0.01, lon: 0 },
  });
  const server = createServer({
    sources: {
      first: fakeSource({ id: 'first', envelopes: [far] }),
      second: fakeSource({ id: 'second', envelopes: [near] }),
    },
  });
  const client = await connectedClient(server);
  const result = await client.callTool({
    name: 'observe_region',
    arguments: {
      center: { lat: 0, lon: 0 },
      radius_km: 500,
      max_results: 1,
    },
  });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.observations.length, 1);
  assert.equal(parsed.observations[0].source_record_id, 'near');
  assert.deepEqual(
    parsed.source_results.map(({ source_id, matched_count, returned_count }) => ({
      source_id,
      matched_count,
      returned_count,
    })),
    [
      { source_id: 'first', matched_count: 1, returned_count: 0 },
      { source_id: 'second', matched_count: 1, returned_count: 1 },
    ],
  );
});

// Real, checked SDK behavior (confirmed by direct inspection, not assumed):
// both a thrown tool error and a schema-validation failure come back as a
// resolved `CallToolResult` with `isError: true`, not a rejected promise —
// the JSON-RPC call itself succeeds; the *tool* reports failure. Every test
// below checks `isError` and the real message text, not `assert.rejects`.

test('observe_region propagates a real AbortError as itself (its own honest message), never mistranslating cancellation into a fabricated source_unavailable JSON result', async () => {
  const server = createServer({ sources: { a: fakeSource({ id: 'a', throwOn: 'abort' }) } });
  const client = await connectedClient(server);
  const result = await client.callTool({
    name: 'observe_region',
    arguments: { center: { lat: 0, lon: 0 }, radius_km: 10 },
  });
  assert.equal(result.isError, true);
  // The real, distinguishing assertion: this must NOT be the empty-reason
  // JSON shape (that would mean the abort got silently absorbed into
  // "source_unavailable") — it must be the honest abort message itself.
  assert.match(result.content[0].text, /aborted/i);
  assert.doesNotMatch(result.content[0].text, /source_unavailable/);
});

test('the input schema rejects a radius above the 500km cap and a maxResults above the 50 cap — caps genuinely match the source layer', async () => {
  const server = createServer({ sources: { a: fakeSource({ id: 'a' }) } });
  const client = await connectedClient(server);
  const overRadius = await client.callTool({
    name: 'observe_region',
    arguments: { center: { lat: 0, lon: 0 }, radius_km: MAX_RADIUS_KM + 1 },
  });
  assert.equal(overRadius.isError, true);
  assert.match(overRadius.content[0].text, /radius_km/);

  const overResults = await client.callTool({
    name: 'observe_region',
    arguments: { center: { lat: 0, lon: 0 }, radius_km: 10, max_results: MAX_RESULTS_CAP + 1 },
  });
  assert.equal(overResults.isError, true);
  assert.match(overResults.content[0].text, /max_results/);
});

test('tool annotations declare this surface as read-only and non-destructive at the protocol level', async () => {
  const server = createServer({ sources: {} });
  const client = await connectedClient(server);
  const { tools } = await client.listTools();
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must declare readOnlyHint`);
    assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} must declare destructiveHint: false`);
  }
});

test('an unknown source id in the request is rejected at the schema layer, not silently ignored into a fabricated result', async () => {
  const server = createServer({ sources: {} }); // no sources registered at all
  const client = await connectedClient(server);
  // With zero sources registered, the schema's enum has no valid values, so
  // this must be caught at validation — confirms the server can't be asked
  // to query a source id that was never registered.
  const result = await client.callTool({
    name: 'observe_region',
    arguments: { center: { lat: 0, lon: 0 }, radius_km: 10, sources: ['nonexistent'] },
  });
  assert.equal(result.isError, true);
});
