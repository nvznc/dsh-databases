/**
 * Verificación funcional del MCP multi-motor contra las conexiones reales.
 * No deja cambios: la prueba de escritura se ejecuta dentro de una transacción
 * que termina en ROLLBACK.
 *
 * Uso: npm run verify            (usa las conexiones de configs/connections.json y .env)
 *      npm run verify -- default (limita a una conexión)
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2];
const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, 'dist', 'index.js')],
  cwd: root,
  env,
  stderr: 'inherit',
});

const client = new Client({ name: 'verify', version: '2.0.0' }, { capabilities: {} });
const checks = [];

const text = (result) => result.content?.find((block) => block.type === 'text')?.text ?? '';
const json = (result) => JSON.parse(text(result));

async function check(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail });
    console.log(`✔ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    checks.push({ name, ok: false, detail: error.message });
    console.log(`✘ ${name} — ${error.message}`);
  }
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(text(result));
  return json(result);
}

const firstCode = (engine) =>
  engine === 'mssql'
    ? 'SELECT 1 AS uno, DB_NAME() AS base'
    : engine === 'mysql'
      ? 'SELECT 1 AS uno, DATABASE() AS base'
      : 'SELECT 1 AS uno, current_database() AS base';

const guardCases = (engine) => {
  const sample = engine === 'mssql' ? 'dbo' : engine === 'mysql' ? 'mysql' : 'public';
  return [
    ['DELETE', 'DELETE FROM ' + (engine === 'mssql' ? 'sys.objects' : `information_schema.tables`)],
    ['múltiples sentencias', 'SELECT 1; SELECT 2'],
    ['DDL', 'DROP TABLE ' + sample + '.nada'],
  ];
};

try {
  await client.connect(transport);

  await check('listTools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const required of ['list_connections', 'test_connection', 'run_query', 'execute_sql', 'save_connection']) {
      if (!names.includes(required)) throw new Error(`falta ${required}`);
    }
    return `${names.length} herramientas`;
  });

  const listing = await call('list_connections', {});
  const targets = listing.connections.filter((entry) => (only ? entry.name === only : true));
  console.log(`Conexiones a probar: ${targets.map((entry) => `${entry.name}(${entry.engine})`).join(', ')}\n`);

  for (const target of targets) {
    const label = `[${target.name}/${target.engine}]`;
    const base = { connection: target.name };

    await check(`${label} test_connection`, async () => {
      const info = await call('test_connection', base);
      return `${info.engine}: ${String(info.server?.version ?? '').slice(0, 60)}`;
    });

    await check(`${label} list_databases`, async () => {
      const result = await call('list_databases', base);
      return `${result.databases.length} bases`;
    });

    let database;
    await check(`${label} list_tables`, async () => {
      const result = await call('list_tables', { ...base, kind: 'tables' });
      if (result.tables.length === 0) throw new Error('sin tablas');
      database = result.database;
      return `${result.tables.length} tablas en ${database}; primera ${result.tables[0].schema}.${result.tables[0].name}`;
    });

    if (!database) continue;

    await check(`${label} describe_table`, async () => {
      const tables = await call('list_tables', { ...base, kind: 'tables' });
      const first = tables.tables[0];
      const info = await call('describe_table', { ...base, database, schema: first.schema, table: first.name });
      return `${first.schema}.${first.name}: ${info.columns.length} columnas, ${info.indexes.length} índices`;
    });

    await check(`${label} run_query`, async () => {
      const result = await call('run_query', { ...base, sql: firstCode(target.engine) });
      return `base=${result.recordsets[0]?.rows?.[0]?.base}`;
    });

    await check(`${label} run_query límite de filas`, async () => {
      const sql =
        target.engine === 'mssql'
          ? 'SELECT TOP 500 * FROM sys.all_objects'
          : target.engine === 'mysql'
            ? 'SELECT * FROM information_schema.COLUMNS LIMIT 500'
            : 'SELECT * FROM pg_catalog.pg_attribute LIMIT 500';
      const result = await call('run_query', { ...base, sql, maxRows: 7 });
      const rows = result.recordsets[0]?.rowCount;
      if (rows !== 7) throw new Error(`esperaba 7 filas, obtuve ${rows}`);
      return `${rows} filas`;
    });

    for (const [name, sql] of guardCases(target.engine)) {
      await check(`${label} guard bloquea ${name}`, async () => {
        const result = await client.callTool({ name: 'run_query', arguments: { ...base, sql } });
        if (!result.isError) throw new Error('¡el guard no bloqueó la sentencia!');
        return text(result).slice(0, 60);
      });
    }

    await check(`${label} guard permite literales con palabras clave`, async () => {
      const result = await call('run_query', { ...base, sql: "SELECT 'DELETE; DROP TABLE x' AS texto" });
      return result.recordsets[0].rows[0].texto;
    });

    await check(`${label} execute_sql con rollback`, async () => {
      const table = '__mcp_verify_tmp';
      const sql =
        target.engine === 'mssql'
          ? `BEGIN TRAN; CREATE TABLE #v (id int); INSERT INTO #v VALUES (1); SELECT COUNT(*) AS n FROM #v; ROLLBACK;`
          : `CREATE TEMP TABLE ${table} (id int); INSERT INTO ${table} VALUES (1); SELECT COUNT(*) AS n FROM ${table}; DROP TABLE ${table};`;
      const result = await call('execute_sql', { ...base, sql });
      const exists =
        target.engine === 'mssql'
          ? 'SELECT COUNT(*) AS n FROM sys.tables WHERE name = \'__mcp_verify_tmp\''
          : target.engine === 'mysql'
            ? "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_NAME = '__mcp_verify_tmp'"
            : "SELECT COUNT(*) AS n FROM pg_class WHERE relname = '__mcp_verify_tmp'";
      const after = await call('run_query', { ...base, database, sql: exists });
      if (Number(after.recordsets[0].rows[0].n) !== 0) throw new Error('quedó una tabla de prueba');
      return `${result.recordsets[0]?.rowCount ?? 0} fila(s) temporal(es)`;
    });
  }
} finally {
  await client.close();
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} comprobaciones OK`);
process.exitCode = failed.length === 0 ? 0 : 1;
