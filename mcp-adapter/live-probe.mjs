// Optional LIVE probe — hits real USGS over the real network. Deliberately
// NOT part of the automated unit/integration suite (server.test.mjs owns
// deterministic, no-network coverage of the real MCP protocol wiring via
// InMemoryTransport). Run this by hand when you want to see the whole stack
// actually talk to the real world: `node live-probe.mjs`.
// Spawns server.mjs as a real stdio subprocess and speaks real MCP protocol
// to it via the official client, exercising the query and handoff tools.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['server.mjs'],
});
const client = new Client({ name: 'smoke-test-client', version: '0.1.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '));

const status = await client.callTool({
  name: 'get_source_status',
  arguments: {},
});
console.log('STATUS:', status.content[0].text);

const region = await client.callTool({
  name: 'observe_region',
  arguments: {
    center: { lat: 37.3, lon: -105.5 },
    radius_km: 500,
    max_results: 5,
  },
});
console.log(
  'OBSERVE_REGION all sources (San Luis Valley, 500km):',
  JSON.stringify(
    {
      returned: region.structuredContent?.observations?.length ?? 0,
      empty_reason: region.structuredContent?.empty_reason ?? null,
      partial: region.structuredContent?.partial ?? null,
      source_results: region.structuredContent?.source_results ?? [],
    },
    null,
    2,
  ),
);

const fires = await client.callTool({
  name: 'observe_region',
  arguments: {
    center: { lat: 37.599207, lon: -119.607392 },
    radius_km: 75,
    max_results: 10,
    sources: ['fires'],
  },
});
console.log(
  'OBSERVE_REGION fires only (DOME/Yosemite gate region, 75km):',
  JSON.stringify(
    {
      returned: fires.structuredContent?.observations?.length ?? 0,
      empty_reason: fires.structuredContent?.empty_reason ?? null,
      partial: fires.structuredContent?.partial ?? null,
      source_results: fires.structuredContent?.source_results ?? [],
    },
    null,
    2,
  ),
);

const selectedFire = fires.structuredContent?.observations?.[0] ?? null;
if (selectedFire) {
  const lookup = await client.callTool({
    name: 'get_observation',
    arguments: {
      source: 'fires',
      source_record_id: selectedFire.source_record_id,
    },
  });
  console.log(
    'GET_OBSERVATION selected fire:',
    JSON.stringify(
      {
        found: lookup.structuredContent?.found ?? false,
        source_record_id:
          lookup.structuredContent?.observation?.source_record_id ?? null,
        state: lookup.structuredContent?.observation?.state ?? null,
        retrieved_at:
          lookup.structuredContent?.observation?.retrieved_at ?? null,
        bbox: lookup.structuredContent?.observation?.geometry?.bbox ?? null,
      },
      null,
      2,
    ),
  );

  const handoff = await client.callTool({
    name: 'open_in_globe',
    arguments: {
      source: 'fires',
      source_record_id: selectedFire.source_record_id,
    },
  });
  console.log(
    'OPEN_IN_GLOBE selected fire:',
    handoff.structuredContent?.url ?? null,
  );
} else {
  console.log(
    'HANDOFF: not attempted because the bounded fire query returned no record.',
  );
}

await client.close();
process.exit(0);
