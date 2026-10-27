import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { AppConfig } from './config.js';
import { assertAllowsDatabase } from './engines/access.js';
import { savedConnectionsPath } from './engines/registry.js';
import type { ConnectionRegistry } from './engines/registry.js';
import { chooseConnection } from './engines/types.js';
import type { EngineKind } from './engines/types.js';
function textResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

async function respond(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return textResult(await fn());
  } catch (error) {
    return errorResult(error);
  }
}

const engineParam = z
  .enum(['mssql', 'mysql', 'postgres'])
  .optional()
  .describe('Motor de base de datos. Por defecto usa MSSQL_ENGINE del .env (mssql si no existe).');

const connectionParam = z
  .string()
  .optional()
  .describe(
    'Nombre de la conexiÃ³n definida en configs/connections.json, guardada con save_connection o "default" (.env). ' +
      'Si se omite se usa la conexiÃ³n por defecto o la indicada por DSH_MCP_SQL_CONNECTION.',
  );

function databaseParam(defaultDatabase: string) {
  return z
    .string()
    .optional()
    .describe(`Nombre de la base de datos. Si se omite se usa la de la conexiÃ³n (por defecto ${defaultDatabase}).`);
}

export function registerTools(server: McpServer, registry: ConnectionRegistry, config: AppConfig): void {
  const allowed = config.allowedDatabases;

  server.registerTool(
    'list_connections',
    {
      title: 'Listar conexiones y motores',
      description:
        'Muestra los motores soportados (mssql, mysql, postgres) y las conexiones configuradas: la del .env ' +
        '("default"), las declaradas en configs/connections.json y las guardadas con save_connection. ' +
        'Usa los nombres que devuelve en el parÃ¡metro "connection" del resto de herramientas.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      respond(async () => ({
        engines: registry.engineLabels,
        defaultEngine: config.engine,
        readOnly: config.readOnly,
        connections: registry.summarize(),
        savedConnectionsFile: savedConnectionsPath,
      })),
  );

  server.registerTool(
    'save_connection',
    {
      title: 'Guardar conexiÃ³n',
      description:
        'Guarda (o reemplaza) una conexiÃ³n con nombre en el archivo de datos del usuario, para luego elegirla ' +
        'con "connection" en list_databases, list_tables, describe_table, run_query y execute_sql. ' +
        'No valida la conexiÃ³n; usa test_connection despuÃ©s de guardar.',
      inputSchema: {
        name: z.string().min(1).describe('Nombre Ãºnico, por ejemplo "farmacia-prod" o "core-mysql".'),
        engine: z.enum(['mssql', 'mysql', 'postgres']).describe('Motor de la conexiÃ³n.'),
        host: z.string().optional().describe('Host o IP (por defecto localhost).'),
        port: z.number().int().min(1).max(65535).optional().describe('Puerto TCP; si se omite se usa el del motor.'),
        database: z.string().optional().describe('Base de datos por defecto de esta conexiÃ³n.'),
        user: z.string().min(1).describe('Usuario del motor.'),
        password: z.string().describe('ContraseÃ±a.'),
        options: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional()
          .describe('Opciones del motor: "encrypt", "trustServerCertificate" (mssql), "ssl" (mysql/postgres).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      respond(async () => {
        const profile = registry.save(input);
        return {
          saved: {
            name: profile.name,
            engine: profile.engine,
            host: profile.host,
            port: profile.port,
            database: profile.database,
            user: profile.user,
          },
          next: `Prueba con test_connection {"connection":"${profile.name}"}.`,
        };
      }),
  );

  server.registerTool(
    'remove_connection',
    {
      title: 'Eliminar conexiÃ³n guardada',
      description: 'Elimina una conexiÃ³n creada con save_connection. No afecta a las del .env ni a configs/connections.json.',
      inputSchema: { name: z.string().min(1).describe('Nombre de la conexiÃ³n guardada.') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ name }) =>
      respond(async () => {
        const removed = registry.remove(name);
        if (!removed) throw new Error(`No hay ninguna conexiÃ³n guardada llamada "${name}".`);
        return { removed: name };
      }),
  );

  server.registerTool(
    'test_connection',
    {
      title: 'Probar conexiÃ³n',
      description:
        'Abre una conexiÃ³n y devuelve la informaciÃ³n real del servidor (versiÃ³n, host, usuario) o el error exacto. ' +
        'Ãšsala despuÃ©s de editar configs/connections.json o de guardar una conexiÃ³n.',
      inputSchema: {
        connection: connectionParam,
        engine: engineParam,
        database: databaseParam(config.database),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ connection, engine, database }) =>
      respond(async () => {
        const profile = registry.resolve(chooseConnection(connection), engine as EngineKind | undefined);
        const adapter = registry.create(profile);
        try {
          const info = await adapter.serverInfo();
          return { ok: true, connection: profile.name, engine: profile.engine, database: profile.database, server: info };
        } finally {
          await adapter.close();
        }
      }),
  );

  server.registerTool(
    'list_databases',
    {
      title: 'Listar bases de datos',
      description:
        'Lista las bases de datos a las que tiene acceso la conexiÃ³n elegida (mssql, mysql o postgres), con estado ' +
        'y tamaÃ±o cuando el motor lo expone. Ãšsala para descubrir quÃ© bases existen antes de consultar tablas.',
      inputSchema: {
        connection: connectionParam,
        engine: engineParam,
        database: databaseParam(config.database),
        includeSystem: z.boolean().optional().describe('Incluye las bases de sistema del motor (por defecto false).'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ connection, engine }) =>
      respond(async () => {
        const profile = registry.resolve(chooseConnection(connection), engine as EngineKind | undefined);
        const adapter = registry.create(profile);
        try {
          const databases = await adapter.listDatabases(false);
          return {
            connection: profile.name,
            engine: profile.engine,
            databases: databases.filter(
              (db) => allowed.length === 0 || allowed.some((name) => name.toLowerCase() === db.name.toLowerCase()),
            ),
          };
        } finally {
          await adapter.close();
        }
      }),
  );

  server.registerTool(
    'list_tables',
    {
      title: 'Listar tablas y vistas',
      description:
        'Lista tablas y/o vistas de la base elegida, filtradas por esquema o por texto en el nombre. ' +
        'Devuelve esquema, nombre, tipo, filas aproximadas y fechas cuando el motor las expone. ' +
        'Es el primer paso para explorar un esquema desconocido en cualquier motor.',
      inputSchema: {
        connection: connectionParam,
        engine: engineParam,
        database: databaseParam(config.database),
        schema: z.string().optional().describe('Esquema (mssql/postgres), por ejemplo "dbo" o "public".'),
        nameContains: z.string().optional().describe('Fragmento del nombre de la tabla.'),
        kind: z.enum(['all', 'tables', 'views']).optional().describe('Tipo de objeto (por defecto all).'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ connection, engine, database, schema, nameContains, kind }) =>
      respond(async () => {
        assertAllowsDatabase(allowed, database);
        const profile = registry.resolve(chooseConnection(connection), engine as EngineKind | undefined);
        const adapter = registry.create(profile);
        try {
          return { connection: profile.name, ...(await adapter.listTables(database, { schema, nameContains, kind })) };
        } finally {
          await adapter.close();
        }
      }),
  );

  server.registerTool(
    'describe_table',
    {
      title: 'Describir una tabla',
      description:
        'Devuelve el esquema detallado de una tabla o vista: columnas con tipo, nulabilidad, valor por defecto, ' +
        'auto-incremento/identidad, Ã­ndices y claves forÃ¡neas. Ãšsala antes de escribir consultas.',
      inputSchema: {
        connection: connectionParam,
        engine: engineParam,
        database: databaseParam(config.database),
        schema: z
          .string()
          .optional()
          .describe('Esquema de la tabla: "dbo" (mssql), "public" (postgres) o la base (mysql).'),
        table: z.string().describe('Nombre exacto de la tabla o vista.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ connection, engine, database, schema, table }) =>
      respond(async () => {
        assertAllowsDatabase(allowed, database);
        const profile = registry.resolve(chooseConnection(connection), engine as EngineKind | undefined);
        const adapter = registry.create(profile);
        try {
          const defaultSchema = profile.engine === 'mssql' ? 'dbo' : profile.engine === 'postgres' ? 'public' : profile.database;
          return {
            connection: profile.name,
            ...(await adapter.describeTable(database, schema || defaultSchema, table)),
          };
        } finally {
          await adapter.close();
        }
      }),
  );

  server.registerTool(
    'run_query',
    {
      title: 'Ejecutar consulta de solo lectura',
      description:
        'Ejecuta una Ãºnica sentencia de lectura (SELECT/WITH; en mysql/postgres tambiÃ©n EXPLAIN, SHOW o DESCRIBE) y ' +
        'devuelve las filas como JSON. No permite escribir ni varias sentencias. Las filas se limitan a ' +
        `${config.maxRows} por defecto (mÃ¡ximo 5000). Usa list_tables y describe_table para explorar.`,
      inputSchema: {
        sql: z.string().describe('Sentencia de lectura. Ejemplo: SELECT TOP 10 * FROM dbo.Clientes ORDER BY id DESC'),
        connection: connectionParam,
        engine: engineParam,
        database: databaseParam(config.database),
        maxRows: z.number().int().min(1).max(5000).optional().describe(`Filas mÃ¡ximas (por defecto ${config.maxRows}).`),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ sql, connection, engine, database, maxRows }) =>
      respond(async () => {
        assertAllowsDatabase(allowed, database);
        const profile = registry.resolve(chooseConnection(connection), engine as EngineKind | undefined);
        const adapter = registry.create(profile);
        try {
          const output = await adapter.runQuery(database, sql, maxRows ?? config.maxRows, 'read');
          return output.rowLimitReached
            ? { connection: profile.name, ...output, notice: `Se alcanzÃ³ el lÃ­mite de ${output.rowLimit} filas; el resultado puede estar truncado.` }
            : { connection: profile.name, ...output };
        } finally {
          await adapter.close();
        }
      }),
  );

  server.registerTool(
    'server_info',
    {
      title: 'InformaciÃ³n del servidor',
      description:
        'Muestra versiÃ³n, host, usuario actual y fecha de arranque del servidor de la conexiÃ³n elegida. ' +
        'Sirve para confirmar a quÃ© servidor y motor se estÃ¡ conectando el MCP.',
      inputSchema: {
        connection: connectionParam,
        engine: engineParam,
        database: databaseParam(config.database),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ connection, engine, database }) =>
      respond(async () => {
        const profile = registry.resolve(chooseConnection(connection), engine as EngineKind | undefined);
        const adapter = registry.create(profile);
        try {
          return { connection: profile.name, engine: profile.engine, server: await adapter.serverInfo() };
        } finally {
          await adapter.close();
        }
      }),
  );

  if (config.allowWrite) {
    server.registerTool(
      'execute_sql',
      {
        title: 'Ejecutar SQL (escritura)',
        description:
          'Escribe en la base: INSERT, UPDATE, DELETE, DDL o procedimientos. Solo estÃ¡ disponible con ' +
          'MSSQL_ALLOW_WRITE=true. Confirma el alcance de la sentencia y comprueba la conexiÃ³n y el motor antes ' +
          'de usarla; prefiere transacciones explÃ­citas para cambios delicados.',
        inputSchema: {
          sql: z.string().describe('Sentencia T-SQL, MySQL o PostgreSQL a ejecutar.'),
          connection: connectionParam,
          engine: engineParam,
          database: databaseParam(config.database),
          maxRows: z.number().int().min(1).max(5000).optional().describe('LÃ­mite de filas devueltas.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ sql, connection, engine, database, maxRows }) =>
        respond(async () => {
          assertAllowsDatabase(allowed, database);
          const profile = registry.resolve(chooseConnection(connection), engine as EngineKind | undefined);
          const adapter = registry.create(profile);
          try {
            return { connection: profile.name, ...(await adapter.runQuery(database, sql, maxRows ?? config.maxRows, 'write')) };
          } finally {
            await adapter.close();
          }
        }),
    );
  }
}
