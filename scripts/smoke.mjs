/**
 * Prueba de humo del MCP: handshake, listado de conexiones, prueba de conexión
 * y una consulta sobre la conexión indicada.
 *
 * Uso: node scripts/smoke.mjs [nombreConexion] [sql]
 *      npm run smoke -- default "SELECT 1 AS ok"
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const connection = process.argv[2];
const query = process.argv[3];

const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, 'dist', 'index.js')],
  cwd: root,
  env,
  stderr: 'inherit',
});

const client = new Client({ name: 'smoke-test', version: '2.0.0' }, { capabilities: {} });
const text = (result) => result.content?.find((block) => block.type === 'text')?.text ?? '';

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`\n✔ ${tools.length} herramientas: ${tools.map((tool) => tool.name).join(', ')}\n`);

  const connections = await client.callTool({ name: 'list_connections', arguments: {} });
  if (connections.isError) throw new Error(text(connections));
  const listed = JSON.parse(text(connections));
  console.log('Motores:', listed.engines.map((entry) => `${entry.engine}:${entry.defaultPort}`).join(', '));
  console.log('Conexiones:', listed.connections.map((entry) => `${entry.name}(${entry.engine})`).join(', '));

  if (connection) {
    const info = await client.callTool({ name: 'test_connection', arguments: { connection } });
    console.log(`\ntest_connection ${connection}:`, info.isError ? `✘ ${text(info)}` : '✔ conectado');
    if (info.isError) process.exitCode = 1;
    else console.log(text(info).slice(0, 300));
  }

  if (query) {
    const result = await client.callTool({ name: 'run_query', arguments: { connection, sql: query } });
    console.log('\nConsulta:', query);
    console.log(result.isError ? `✘ ${text(result)}` : `✔ ${text(result).slice(0, 400)}`);
    if (result.isError) process.exitCode = 1;
  }
} finally {
  await client.close();
}
