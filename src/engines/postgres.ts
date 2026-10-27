import { performance } from 'node:perf_hooks';

import { Client } from 'pg';

import { assertReadOnly } from '../guard.js';
import { rowsToPlain } from './shared.js';
import type { ConnectionProfile, DatabaseInfo, EngineAdapter, QueryOutput, TableDescription, TableSummary } from './types.js';

function optNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function describePgError(error: unknown): Error {
  const err = error as { message?: string; code?: string; detail?: string; hint?: string; position?: string };
  const hints: Record<string, string> = {
    '28P01': 'Contraseña incorrecta para ese usuario de PostgreSQL.',
    '28000': 'Autenticación rechazada: revisa usuario y los permisos de pg_hba.conf.',
    '3D000': 'La base de datos indicada no existe.',
    '42P01': 'La tabla indicada no existe (recuerda el esquema, p. ej. public.tabla).',
    ECONNREFUSED: 'No hay nada escuchando: verifica host/puerto (por defecto 5432) y postgresql.conf.',
    ENOTFOUND: 'No se pudo resolver el nombre del host.',
    ETIMEDOUT: 'Se agotó el tiempo de conexión al servidor PostgreSQL.',
  };
  const message = err?.message ?? String(error);
  const parts = [message];
  if (err?.code) parts.push(`(${err.code})`);
  if (err?.detail) parts.push(`— ${err.detail}`);
  if (err?.hint) parts.push(`Sugerencia: ${err.hint}`);
  if (err?.position) parts.push(`(posición ${err.position})`);
  if (err?.code && hints[err.code]) parts.push(`→ ${hints[err.code]}`);
  const wrapped = new Error(parts.join(' '));
  wrapped.cause = error;
  return wrapped;
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** Motor PostgreSQL. Un Client por base de datos (no hay pool global entre bases). */
export class PostgresAdapter implements EngineAdapter {
  readonly kind = 'postgres' as const;
  private readonly clients = new Map<string, Promise<Client>>();

  constructor(
    private readonly profile: ConnectionProfile,
    private readonly limits: { maxRows: number; queryTimeoutMs: number; connectTimeoutMs: number; readOnly: boolean },
  ) {}

  private async connect(database: string): Promise<Client> {
    const options = this.profile.options;
    const ssl = options.ssl;
    const client = new Client({
      host: this.profile.host,
      port: this.profile.port,
      database,
      user: this.profile.user,
      password: this.profile.password,
      connectionTimeoutMillis: optNumber(options.connectTimeout) ?? this.limits.connectTimeoutMs,
      statement_timeout: this.limits.queryTimeoutMs,
      query_timeout: this.limits.queryTimeoutMs,
      ssl: ssl === true || ssl === 'true' ? { rejectUnauthorized: false } : ssl === false || ssl === 'false' ? false : undefined,
      application_name: 'mcp-databases',
    });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);
      throw describePgError(error);
    }
  }

  private async clientFor(database: string): Promise<Client> {
    const key = database.toLowerCase();
    const cached = this.clients.get(key);
    if (cached) {
      const client = await cached;
      // Un Client cerrado por el servidor no se puede reutilizar.
      if ((client as unknown as { _ending?: boolean })._ending !== true) return client;
      this.clients.delete(key);
    }

    const pending = this.connect(database);
    this.clients.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      this.clients.delete(key);
      throw error;
    }
  }

  private async run(database: string, text: string): Promise<Array<Record<string, unknown>>> {
    const client = await this.clientFor(database);
    try {
      const result = await client.query(text);
      return result.rows as Array<Record<string, unknown>>;
    } catch (error) {
      throw describePgError(error);
    }
  }

  async ping(): Promise<void> {
    await this.run(this.profile.database || 'postgres', 'SELECT 1 AS ok');
  }

  async databaseNames(): Promise<string[]> {
    const rows = await this.run('postgres', 'SELECT datname AS name FROM pg_database WHERE datallowconn ORDER BY datname');
    return rows.map((row) => String(row.name));
  }

  async resolveDatabase(requested?: string): Promise<string> {
    const wanted = (requested ?? this.profile.database ?? '').trim();
    if (wanted === '') throw new Error('Falta el nombre de la base de datos para PostgreSQL.');
    const names = await this.databaseNames();
    const match = names.find((name) => name.toLowerCase() === wanted.toLowerCase());
    if (!match) throw new Error(`No existe la base "${wanted}" o el usuario no tiene acceso. Accesibles: ${names.join(', ')}.`);
    return match;
  }

  async serverInfo(): Promise<Record<string, unknown>> {
    const rows = await this.run('postgres', `
      SELECT
        version() AS version,
        current_database() AS currentDatabase,
        current_user AS currentUser,
        inet_server_addr()::text AS serverAddress,
        inet_server_port() AS serverPort,
        pg_postmaster_start_time() AS startedAt,
        now() AS serverTime
    `);
    return rowsToPlain(rows).rows[0] ?? {};
  }

  async listDatabases(includeSystem: boolean): Promise<DatabaseInfo[]> {
    const rows = await this.run('postgres', `
      SELECT
        d.datname AS name,
        pg_database_size(d.datname) AS bytes,
        ROUND(pg_database_size(d.datname) / 1048576.0, 1) AS sizeMb,
        pg_get_userbyid(d.datdba) AS owner,
        d.datistemplate AS isTemplate
      FROM pg_database d
      WHERE d.datallowconn
      ORDER BY d.datname
    `);
    return rows
      .filter((row) => includeSystem || !['postgres', 'template0', 'template1'].includes(String(row.name)))
      .map((row) => ({
        name: String(row.name),
        sizeMb: optNumber(row.sizeMb),
        extra: { owner: row.owner, isTemplate: row.isTemplate },
      }));
  }

  async listTables(
    database: string | undefined,
    options: { schema?: string; nameContains?: string; kind?: 'all' | 'tables' | 'views' },
  ): Promise<{ database: string; tables: TableSummary[] }> {
    const db = await this.resolveDatabase(database);
    const kind = options.kind ?? 'all';
    const conditions: string[] = ["t.table_schema NOT IN ('pg_catalog', 'information_schema')"];
    const params: Array<string> = [];
    if (options.schema) {
      params.push(options.schema);
      conditions.push(`t.table_schema = $${params.length}`);
    }
    if (options.nameContains) {
      params.push(`%${escapeLike(options.nameContains.toLowerCase())}%`);
      conditions.push(`lower(t.table_name) LIKE $${params.length} ESCAPE '\\'`);
    }
    if (kind === 'views') conditions.push("t.table_type = 'VIEW'");
    if (kind === 'tables') conditions.push("t.table_type = 'BASE TABLE'");

    const rows = await this.runWithParams(db, `
      SELECT
        t.table_schema AS schema,
        t.table_name AS name,
        CASE WHEN t.table_type = 'VIEW' THEN 'view' ELSE 'table' END AS type,
        c.reltuples::bigint AS rowCount
      FROM information_schema.tables t
      LEFT JOIN pg_class c ON c.relname = t.table_name
        AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = t.table_schema)
      WHERE ${conditions.join(' AND ')}
      ORDER BY t.table_schema, t.table_name
    `, params);

    const tables: TableSummary[] = rows.map((row) => ({
      schema: String(row.schema),
      name: String(row.name),
      type: row.type === 'view' ? 'view' : 'table',
      rowCount: optNumber(row.rowCount),
      createdAt: null,
      modifiedAt: null,
    }));
    return { database: db, tables };
  }

  private async runWithParams(
    database: string,
    text: string,
    params: Array<string | number>,
  ): Promise<Array<Record<string, unknown>>> {
    const client = await this.clientFor(database);
    try {
      const result = await client.query(text, params);
      return result.rows as Array<Record<string, unknown>>;
    } catch (error) {
      throw describePgError(error);
    }
  }

  async describeTable(database: string | undefined, schema: string, table: string): Promise<TableDescription> {
    const db = await this.resolveDatabase(database);

    const columns = await this.runWithParams(db, `
      SELECT
        c.ordinal_position AS ordinal,
        c.column_name AS name,
        c.data_type AS dataType,
        CASE
          WHEN c.character_maximum_length IS NOT NULL THEN c.character_maximum_length::text
          WHEN c.data_type = 'numeric' AND c.numeric_precision IS NOT NULL
            THEN c.numeric_precision || ',' || COALESCE(c.numeric_scale, 0)
          ELSE NULL
        END AS typeArgs,
        c.is_nullable = 'YES' AS nullable,
        c.column_default AS defaultValue,
        (c.column_default LIKE 'nextval(%') AS identity,
        c.udt_name AS udt
      FROM information_schema.columns c
      WHERE c.table_schema = $1 AND c.table_name = $2
      ORDER BY c.ordinal_position
    `, [schema, table]);

    if (columns.length === 0) throw new Error(`No existe la tabla ${quote(schema)}.${quote(table)} en la base "${db}".`);

    const indexes = await this.runWithParams(db, `
      SELECT
        i.relname AS name,
        ix.indisunique AS isUnique,
        ix.indisprimary AS isPrimary,
        string_agg(a.attname, ', ' ORDER BY k.ord) AS columns
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE n.nspname = $1 AND t.relname = $2
      GROUP BY i.relname, ix.indisunique, ix.indisprimary
      ORDER BY ix.indisprimary DESC, i.relname
    `, [schema, table]);

    const fks = await this.runWithParams(db, `
      SELECT
        con.conname AS name,
        string_agg(a.attname, ', ' ORDER BY k.ord) AS columns,
        cn.nspname || '.' || ct.relname AS referencedTable,
        string_agg(ra.attname, ', ' ORDER BY k.ord) AS referencedColumns
      FROM pg_constraint con
      JOIN pg_class t ON t.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_class ct ON ct.oid = con.confrelid
      JOIN pg_namespace cn ON cn.oid = ct.relnamespace
      CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, rattnum, ord)
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
      JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.rattnum
      WHERE con.contype = 'f' AND n.nspname = $1 AND t.relname = $2
      GROUP BY con.conname, cn.nspname, ct.relname
      ORDER BY con.conname
    `, [schema, table]);

    let rowCount: number | null = null;
    try {
      const count = await this.run(db, `SELECT count(*)::bigint AS n FROM ${quote(schema)}.${quote(table)}`);
      rowCount = optNumber(count[0]?.n);
    } catch {
      rowCount = null;
    }

    return {
      database: db,
      schema,
      name: table,
      type: 'BASE TABLE',
      rowCount,
      columns: columns.map((column, index) => ({
        ordinal: optNumber(column.ordinal) ?? index + 1,
        name: String(column.name),
        dataType: String(column.dataType),
        typeArgs: column.typeArgs === null ? null : String(column.typeArgs),
        nullable: Boolean(column.nullable),
        defaultValue: column.defaultValue === null ? null : String(column.defaultValue),
        identity: Boolean(column.identity),
        extra: String(column.udt ?? ''),
      })),
      indexes: indexes.map((index) => ({
        name: String(index.name),
        unique: Boolean(index.isunique),
        primary: Boolean(index.isprimary),
        columns: String(index.columns ?? ''),
      })),
      foreignKeys: fks.map((fk) => ({
        name: String(fk.name),
        columns: String(fk.columns ?? ''),
        referencedTable: String(fk.referencedTable),
        referencedColumns: String(fk.referencedColumns ?? ''),
      })),
    };
  }

  async runQuery(database: string | undefined, sqlText: string, maxRows: number, mode: 'read' | 'write'): Promise<QueryOutput> {
    if (mode === 'read') assertReadOnly(sqlText, 'explain');
    if (!sqlText || sqlText.trim() === '') throw new Error('La sentencia está vacía.');

    const db = await this.resolveDatabase(database);
    const rowLimit = Math.min(maxRows, 5000);
    const client = await this.clientFor(db);
    const started = performance.now();

    try {
      const result = await client.query(sqlText);
      const elapsedMs = Math.round(performance.now() - started);
      if (Array.isArray(result.rows) && result.fields.length > 0) {
        const limited = result.rows.slice(0, rowLimit) as Array<Record<string, unknown>>;
        return {
          database: db,
          rowLimit,
          rowLimitReached: result.rows.length > rowLimit || result.rows.length === rowLimit,
          elapsedMs,
          rowsAffected: [],
          recordsets: [rowsToPlain(limited, result.fields.map((field) => field.name))],
        };
      }
      return {
        database: db,
        rowLimit,
        rowLimitReached: false,
        elapsedMs,
        rowsAffected: result.rowCount === null ? [] : [result.rowCount],
        recordsets: [],
      };
    } catch (error) {
      throw describePgError(error);
    }
  }

  async close(): Promise<void> {
    const pending = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(
      pending.map(async (entry) => {
        try {
          await (await entry).end();
        } catch {
          // Client que nunca conectó.
        }
      }),
    );
  }
}
