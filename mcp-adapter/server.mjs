#!/usr/bin/env node
// Eagle Eyes Global — Alliance geospatial query surface (Phase 1).
//
// Read-only MCP server exposing the same live geospatial evidence the Cesium
// globe UI shows, so Claude/Orion/Grok can query it directly from inside a
// session instead of opening a browser. Camera/layer-control authority is
// deliberately NOT exposed here — this server can only observe, never act on
// the globe. See plans/gods_eye_alliance_geospatial_plan_2026-09-18.md
// (SentinelHome) for the full design, agreed jointly by Claude, Orion, and
// Grok Sentinel, authorized by James Harwood.
//
// Current scope: two sources (USGS earthquakes and NASA EONET + NIFC WFIGS
// fires), two tools (get_source_status, observe_region). Additional tools
// (nearby_observations, get_observation, open_in_globe) land after this
// slice is reviewed and proven, per the plan's own "prove it before
// generalizing" discipline.
//
// Revised per Orion Sentinel's round-3 transport authorization (2026-09-18):
// caps aligned with the source layer (500km/50), the real MCP call signal is
// threaded into the source so a caller can actually cancel their own request,
// a genuine cancellation propagates as itself rather than being mistranslated
// into a misleading SOURCE_UNAVAILABLE result, outputSchema + structuredContent
// are provided alongside the text/JSON content, and tool annotations declare
// this surface's real authority shape (read-only, non-destructive, open-world)
// at the protocol level rather than only by convention.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { createEarthquakesEvidenceSource } from './sources/earthquakes.mjs';
import { createFiresEvidenceSource } from './sources/fires.mjs';
import {
  buildEmptyResult,
  EMPTY_REASON,
  haversineKm,
  SOURCE_STATE,
} from './evidenceEnvelope.mjs';

/** These two caps are the single source of truth for both the source layer
 * (sources/earthquakes.mjs) and this transport layer's input schema — do not
 * let them drift apart again the way they did in the original draft (2000km/
 * 200 here vs. 500km/50 in the source, caught in round 2). */
export const MAX_RADIUS_KM = 500;
export const MAX_RESULTS_CAP = 50;

/** Factory so tests can inject a fake source registry without touching the
 * real network — see manual-smoke-check.mjs / the deterministic integration
 * test for the actual usage. Production just calls this with no arguments. */
function defaultSources() {
  const earthquakes = createEarthquakesEvidenceSource();
  const fires = createFiresEvidenceSource();
  return { [earthquakes.id]: earthquakes, [fires.id]: fires };
}

export function createServer({ sources = defaultSources() } = {}) {
  const SOURCES = sources;
  const sourceIds = Object.keys(SOURCES);

  const server = new McpServer({
    name: 'eagle-eyes-global-geo',
    version: '0.1.0',
  });

  const sourceStatusShape = {
    id: z.string(),
    state: z.enum(Object.values(SOURCE_STATE)),
    last_success_at: z.string().nullable(),
    note: z.string().nullable(),
  };

  server.registerTool(
    'get_source_status',
    {
      title: 'Get source status',
      description:
        'Report current health for every registered geospatial evidence source: live, stale, degraded, unavailable, or not yet queried, with the last successful fetch time. Never triggers a new fetch by itself.',
      inputSchema: {},
      outputSchema: {
        sources: z.array(z.object(sourceStatusShape)),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const result = { sources: Object.values(SOURCES).map((s) => s.getStatus()) };
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  // Loosely typed on purpose: each source's `observation` payload shape
  // differs (earthquakes carries magnitude/place; fires will carry
  // incident_name/acres/containment_pct/etc, per Grok Sentinel's spec on
  // alliance-wire) — the envelope's fixed fields are validated strictly, the
  // source-specific extension stays a passthrough record rather than forcing
  // every future source into one rigid shape prematurely.
  const evidenceEnvelopeShape = z
    .object({
      source: z.string(),
      source_record_id: z.string(),
      observed_at: z.string().nullable(),
      retrieved_at: z.string(),
      expires_at: z.string().nullable(),
      freshness_ms: z.number().nullable(),
      state: z.enum(Object.values(SOURCE_STATE)),
      geometry: z.object({ lat: z.number(), lon: z.number() }).passthrough().nullable(),
      attribution: z.string(),
      license: z.string(),
      limitations: z.array(z.string()),
      privacy_class: z.string(),
      observation: z.record(z.string(), z.unknown()),
    })
    .passthrough();

  const sourceResultShape = z.object({
    source_id: z.string(),
    outcome: z.enum(['observations', 'observed_zero', 'source_unavailable']),
    state: z.enum(Object.values(SOURCE_STATE)),
    matched_count: z.number().int().nonnegative().describe(
      'Candidates returned by this source after its own source-level bounds; not an uncapped upstream total',
    ),
    returned_count: z.number().int().nonnegative().describe(
      'Candidates from this source retained after the cross-source global result cap',
    ),
    note: z.string().nullable(),
  });

  server.registerTool(
    'observe_region',
    {
      title: 'Observe region',
      description:
        'Bounded spatial query: return evidence-enveloped observations from one or more sources within a radius of a center point. Never fabricates a plausible answer when a source has nothing — always names which of five reasons applies when empty.',
      inputSchema: {
        center: z.object({
          lat: z.number().min(-90).max(90),
          lon: z.number().min(-180).max(180),
        }),
        radius_km: z.number().positive().max(MAX_RADIUS_KM),
        sources: z
          .array(z.enum(sourceIds.length > 0 ? sourceIds : ['__none__']))
          .min(1)
          .default(sourceIds),
        max_results: z.number().int().positive().max(MAX_RESULTS_CAP).default(MAX_RESULTS_CAP),
        min_acres: z
          .number()
          .min(0)
          .optional()
          .describe('Fires only: exclude fires smaller than this. Ignored by sources that have no acreage concept.'),
        include_prescribed: z
          .boolean()
          .optional()
          .describe('Fires only: include prescribed/RX burns (excluded by default). Ignored by other sources.'),
      },
      outputSchema: {
        observations: z.array(evidenceEnvelopeShape),
        empty_reason: z.enum(Object.values(EMPTY_REASON)).nullable(),
        partial: z.boolean(),
        source_results: z.array(sourceResultShape),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        // Not idempotent in the everyday sense: the same query issued a
        // moment later can legitimately return different results, because
        // the underlying world changed — this is a live observation surface,
        // not a lookup against a fixed record.
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ center, radius_km, sources, max_results, min_acres, include_prescribed }, extra) => {
      extra.signal?.throwIfAborted();
      const candidates = [];
      const sourceResults = [];
      let anySourceQueried = false;
      let anySourceUnavailable = false;

      for (const sourceId of sources) {
        const source = SOURCES[sourceId];
        if (!source) continue; // not_covered — this adapter doesn't know this source id
        anySourceQueried = true;
        try {
          const envelopes = await source.observeRegion({
            centerLat: center.lat,
            centerLon: center.lon,
            radiusKm: radius_km,
            maxResults: max_results,
            signal: extra.signal,
            // Source-specific filters — each source's own observeRegion
            // destructures only what it understands; earthquakes.mjs simply
            // ignores these two, so passing them universally is harmless.
            minAcres: min_acres,
            includePrescribed: include_prescribed,
          });
          const status = source.getStatus();
          sourceResults.push({
            source_id: sourceId,
            outcome: envelopes.length > 0 ? 'observations' : 'observed_zero',
            state: status.state,
            matched_count: envelopes.length,
            returned_count: 0,
            note: status.note,
          });
          for (const envelope of envelopes) {
            candidates.push({
              sourceId,
              envelope,
              distanceKm: haversineKm(
                center.lat,
                center.lon,
                envelope.geometry.lat,
                envelope.geometry.lon,
              ),
            });
          }
        } catch (err) {
          // A real caller cancellation must propagate as itself — collapsing
          // it into SOURCE_UNAVAILABLE would tell the caller their own
          // cancelled request "failed," which is a different and false claim.
          if (err?.name === 'AbortError') throw err;
          anySourceUnavailable = true;
          let status;
          try {
            status = source.getStatus();
          } catch {
            status = {
              state: SOURCE_STATE.UNAVAILABLE,
              note: null,
            };
          }
          sourceResults.push({
            source_id: sourceId,
            outcome: 'source_unavailable',
            // The acquisition cache may still report LIVE even when record
            // adaptation/query serving failed. This field describes this
            // query outcome, so a call that returned no usable evidence is
            // unavailable regardless of the underlying cache state.
            state: SOURCE_STATE.UNAVAILABLE,
            matched_count: 0,
            returned_count: 0,
            note: status.note ?? err?.message ?? 'Source unavailable',
          });
        }
      }

      // Each source already returns its nearest max_results records. Sorting
      // their union here selects the true nearest global max_results without
      // allowing registry/source order to starve a later source.
      const selected = candidates
        .sort(
          (a, b) =>
            a.distanceKm - b.distanceKm ||
            a.sourceId.localeCompare(b.sourceId) ||
            String(a.envelope.source_record_id).localeCompare(
              String(b.envelope.source_record_id),
            ),
        )
        .slice(0, max_results);
      const returnedBySource = new Map();
      for (const item of selected) {
        returnedBySource.set(item.sourceId, (returnedBySource.get(item.sourceId) ?? 0) + 1);
      }
      const completedSourceResults = sourceResults.map((result) => ({
        ...result,
        returned_count: returnedBySource.get(result.source_id) ?? 0,
      }));
      const partial =
        anySourceUnavailable &&
        completedSourceResults.some((result) => result.outcome !== 'source_unavailable');

      if (selected.length > 0) {
        const result = {
          observations: selected.map((item) => item.envelope),
          empty_reason: null,
          partial,
          source_results: completedSourceResults,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      }

      const emptyReason = !anySourceQueried
        ? EMPTY_REASON.NOT_COVERED
        : anySourceUnavailable
          ? EMPTY_REASON.SOURCE_UNAVAILABLE
          : EMPTY_REASON.OBSERVED_ZERO;

      const result = {
        ...buildEmptyResult(emptyReason),
        partial,
        source_results: completedSourceResults,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  return server;
}

// Only actually connect a real stdio transport when run directly (`node
// server.mjs`) — importing `createServer` from a test must never open a real
// process transport as a side effect. Uses `pathToFileURL` rather than a bare
// string comparison against `import.meta.url`: on Windows, `process.argv[1]`
// is a backslash path (`C:\...`) while `import.meta.url` always uses forward
// slashes (`file:///C:/...`) — a naive `file://${process.argv[1]}` comparison
// silently never matches on Windows, so the guard never fires, the server
// never actually connects, and the process exits immediately with nothing
// keeping it alive. Caught this live: it made `manual-smoke-check.mjs`
// (which spawns `server.mjs` as a real child process) fail with "MCP error
// -32000: Connection closed" — the child had already exited before the
// client's stdio handshake could complete.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
