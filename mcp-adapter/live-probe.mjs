// Optional LIVE probe — hits real USGS over the real network. Deliberately
// NOT part of the automated unit/integration suite (server.test.mjs owns
// deterministic, no-network coverage of the real MCP protocol wiring via
// InMemoryTransport). Run this by hand when you want to see the whole stack
// actually talk to the real world: `node live-probe.mjs`.
// Spawns server.mjs as a real stdio subprocess and speaks real MCP protocol
// to it via the official client, calling both tools.
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

const status = await client.callTool({ name: 'get_source_status', arguments: {} });
console.log('STATUS:', status.content[0].text);

const region = await client.callTool({
  name: 'observe_region',
  arguments: { center: { lat: 37.3, lon: -105.5 }, radius_km: 500 },
});
console.log('OBSERVE_REGION all sources (San Luis Valley, 500km):', region.content[0].text);

const fires = await client.callTool({
  name: 'observe_region',
  arguments: { center: { lat: 39.5, lon: -119.5 }, radius_km: 500, sources: ['fires'] },
});
console.log('OBSERVE_REGION fires only (Northern Nevada/California, 500km):', fires.content[0].text);

await client.close();
process.exit(0);
