import { createPool } from 'mysql2/promise';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { performance } from 'node:perf_hooks';

import { assertReadOnly } from '../guard.js';
import { log } from '../logger.js';
import { rowsToPlain } from './shared.js';
import type { ConnectionProfile, DatabaseInfo, EngineAdapter, QueryOutput, TableDescription, TableSummary } from './types.js';

function optNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function describeMysqlError(error: unknown): Error {
  const err = error as { message?: string; code?: string; errno?: number; sqlMessage?: string };
  const code = err?.code;
  const message = err?.sqlMessage ?? err?.message ?? String(error);
  const hints: Record<string, string> = {
    ER_ACCESS_DENIED_ERROR: 'Acceso denegado: revisa usuario/contraseña y el host permitido para ese usuario (% / localhost).',
    ECONNREFUSED: 'No hay nada escuchando: verifica host/puerto (por defecto 3306) y que MySQL acepte TCP.',
    ETIMEDOUT: 'Se agotó el tiempo de conexión al servidor MySQL.',
    ENOTFOUND: 'No se pudo resolver el nombre del host.',
    ER_BAD_DB_ERROR: 'La base de datos indicada no existe.',
    ER_NO_SUCH_TABLE: 'La tabla indicada no existe en esa base.',
  };
  const parts = [message];
  if (code) parts.push(`(${code}${err.errno ? ` ${err.errno}` : ''})`);
  if (code && hints[code]) parts.push(`→ ${hints[code]}`);
  const wrapped = new Error(parts.join(' '));
  wrapped.cause = error;
  return wrapped;
}

function quote(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** Motor MySQL / MariaDB. */
export class MysqlAdapter implements EngineAdapter {
  readonly kind = 'mysql' as const;
  private readonly pools = new Map<string, Promise<Pool>>();

  constructor(
    private readonly profile: ConnectionProfile,
    private readonly limits: { maxRows: number; queryTimeoutMs: number; connectTimeoutMs: number; readOnly: boolean },
  ) {}

  private createFor(database: string): Pool {
    const options = this.profile.options;
    const sslOption = options.ssl;
    return createPool({
      host: this.profile.host,
      port: this.profile.port,
      database,
      user: this.profile.user,
      password: this.profile.password,
      waitForConnections: true,
      connectionLimit: 5,
      connectTimeout: optNumber(options.connectTimeout) ?? this.limits.connectTimeoutMs,
      dateStrings: false,
      multipleStatements: false,
      ...(sslOption === true ? { ssl: { rejectUnauthorized: false } } : {}),
    });
  }

  private async poolFor(database: string): Promise<Pool> {
    const key = database.toLowerCase();
    const cached = this.pools.get(key);
    if (cached) return cached;

    const pending = (async () => {
      const pool = this.createFor(database);
      try {
        const connection = await pool.getConnection();
        connection.release();
        return pool;
      } catch (error) {
        await pool.end().catch(() => undefined);
        throw describeMysqlError(error);
      }
    })();

    this.pools.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      this.pools.delete(key);
      throw error;
    }
  }

  private async query<T extends RowDataPacket[]>(database: string, text: string): Promise<T> {
    const pool = await this.poolFor(database);
    try {
      const [rows] = await pool.query<T>({ sql: text, timeout: this.limits.queryTimeoutMs });
      return rows;
    } catch (error) {
      throw describeMysqlError(error);
    }
  }

  private async systemPool(): Promise<Pool> {
    return this.poolFor('mysql');
  }

  async ping(): Promise<void> {
    const pool = await this.poolFor(this.profile.database || 'mysql');
    const connection = await pool.getConnection();
    try {
      await connection.query('SELECT 1');
    } finally {
      connection.release();
    }
  }

  async databaseNames(): Promise<string[]> {
    const rows = await this.query<RowDataPacket[]>('mysql', 'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME');
    return rows.map((row) => String(row.name));
  }

  async resolveDatabase(requested?: string): Promise<string> {
    const wanted = (requested ?? this.profile.database ?? '').trim();
    if (wanted === '') throw new Error('Falta el nombre de la base de datos para MySQL.');
    const names = await this.databaseNames();
    const match = names.find((name) => name.toLowerCase() === wanted.toLowerCase());
    if (!match) throw new Error(`No existe la base "${wanted}" o el usuario no tiene acceso. Accesibles: ${names.join(', ')}.`);
    return match;
  }

  async serverInfo(): Promise<Record<string, unknown>> {
    const rows = await this.query<RowDataPacket[]>('mysql', `
      SELECT
        @@version AS version,
        @@version_comment AS versionComment,
        @@hostname AS hostname,
        @@port AS port,
        CURRENT_USER() AS currentUser,
        DATABASE() AS currentDatabase,
        NOW() AS serverTime
    `);
    return rowsToPlain(rows as unknown as Array<Record<string, unknown>>).rows[0] ?? {};
  }

  async listDatabases(includeSystem: boolean): Promise<DatabaseInfo[]> {
    const rows = await this.query<RowDataPacket[]>('mysql', `
      SELECT
        s.SCHEMA_NAME AS name,
        ROUND(COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) / 1048576, 1) AS sizeMb,
        COUNT(DISTINCT t.TABLE_NAME) AS tableCount,
        s.DEFAULT_CHARACTER_SET_NAME AS charset,
        s.DEFAULT_COLLATION_NAME AS collationName
      FROM information_schema.SCHEMATA s
      LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
      GROUP BY s.SCHEMA_NAME, s.DEFAULT_CHARACTER_SET_NAME, s.DEFAULT_COLLATION_NAME
      ORDER BY s.SCHEMA_NAME
    `);
    const system = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
    return rows
      .filter((row) => includeSystem || !system.has(String(row.name).toLowerCase()))
      .map((row) => ({
        name: String(row.name),
        sizeMb: optNumber(row.sizeMb),
        extra: { tableCount: optNumber(row.tableCount), charset: row.charset, collation: row.collationName },
      }));
  }

  async listTables(
    database: string | undefined,
    options: { schema?: string; nameContains?: string; kind?: 'all' | 'tables' | 'views' },
  ): Promise<{ database: string; tables: TableSummary[] }> {
    const db = await this.resolveDatabase(database);
    const kind = options.kind ?? 'all';
    const conditions: string[] = ['t.TABLE_SCHEMA = ?'];
    const params: Array<string | number> = [db];
    if (kind === 'views') conditions.push("t.TABLE_TYPE = 'VIEW'");
    if (kind === 'tables') conditions.push("t.TABLE_TYPE = 'BASE TABLE'");
    if (options.nameContains) {
      conditions.push("t.TABLE_NAME LIKE ? ESCAPE '\\\\'");
      params.push(`%${escapeLike(options.nameContains)}%`);
    }
    const pool = await this.poolFor(db);
    try {
      const [rows] = await pool.query<RowDataPacket[]>(
        {
          sql: `
            SELECT
              t.TABLE_SCHEMA AS dbSchema,
              t.TABLE_NAME AS name,
              CASE WHEN t.TABLE_TYPE = 'VIEW' THEN 'view' ELSE 'table' END AS type,
              CASE WHEN t.TABLE_TYPE = 'VIEW' THEN NULL ELSE CAST(t.TABLE_ROWS AS SIGNED) END AS rowCount,
              t.CREATE_TIME AS createdAt,
              t.UPDATE_TIME AS modifiedAt
            FROM information_schema.TABLES t
            WHERE ${conditions.join(' AND ')}
            ORDER BY t.TABLE_NAME
          `,
          values: params,
          timeout: this.limits.queryTimeoutMs,
        },
        [],
      );
      const tables: TableSummary[] = (rows as unknown as Array<Record<string, unknown>>).map((row) => ({
        schema: db,
        name: String(row.name),
        type: row.type === 'view' ? 'view' : 'table',
        rowCount: optNumber(row.rowCount),
        createdAt: row.createdAt ? String(row.createdAt) : null,
        modifiedAt: row.modifiedAt ? String(row.modifiedAt) : null,
      }));
      return { database: db, tables };
    } catch (error) {
      throw describeMysqlError(error);
    }
  }

  async describeTable(database: string | undefined, schema: string, table: string): Promise<TableDescription> {
    const db = await this.resolveDatabase(database);
    const pool = await this.poolFor(db);

    try {
      const [typeRows] = await pool.query<RowDataPacket[]>(
        { sql: 'SELECT TABLE_TYPE AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', values: [db, table] },
        [],
      );
      const typeRow = (typeRows as unknown as Array<Record<string, unknown>>)[0];
      if (!typeRow) throw new Error(`No existe la tabla ${quote(schema)}.${quote(table)} en la base "${db}".`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('No existe')) throw error;
      throw describeMysqlError(error);
    }

    const [columnRows] = await pool.query<RowDataPacket[]>({ sql: 'SHOW FULL COLUMNS FROM ?? FROM ??', values: [table, db] }, []);
    const [indexRows] = await pool.query<RowDataPacket[]>({ sql: 'SHOW INDEX FROM ?? FROM ??', values: [table, db] }, []);
    const [fkRows] = await pool.query<RowDataPacket[]>({
      sql: `SELECT CONSTRAINT_NAME AS constraintName, COLUMN_NAME AS columnName, REFERENCED_TABLE_SCHEMA AS refSchema,
                   REFERENCED_TABLE_NAME AS refTable, REFERENCED_COLUMN_NAME AS refColumn
            FROM information_schema.KEY_COLUMN_USAGE
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
            ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
      values: [db, table],
    }, []);

    const columns = (columnRows as unknown as Array<Record<string, unknown>>).map((row, index) => ({
      ordinal: index + 1,
      name: String(row.Field),
      dataType: String(row.Type),
      typeArgs: null,
      nullable: String(row.Null).toUpperCase() === 'YES',
      defaultValue: row.Default === null || row.Default === undefined ? null : String(row.Default),
      identity: String(row.Extra ?? '').toLowerCase().includes('auto_increment'),
      extra: [row.Key ? `key=${String(row.Key)}` : null, row.Extra ? String(row.Extra) : null]
        .filter(Boolean)
        .join(' '),
    }));

    const indexMap = new Map<string, { nonUnique: boolean; columns: Array<{ seq: number; name: string }> }>();
    for (const row of indexRows as unknown as Array<Record<string, unknown>>) {
      const name = String(row.Key_name);
      const entry = indexMap.get(name) ?? { nonUnique: Number(row.Non_unique) === 1, columns: [] };
      entry.columns.push({ seq: Number(row.Seq_in_index), name: String(row.Column_name) });
      indexMap.set(name, entry);
    }
    const indexes = [...indexMap.entries()].map(([name, entry]) => ({
      name,
      unique: !entry.nonUnique,
      primary: name === 'PRIMARY',
      columns: entry.columns.sort((a, b) => a.seq - b.seq).map((column) => column.name).join(', '),
    }));

    const fkMap = new Map<string, { ref: string; columns: string[]; refColumns: string[] }>();
    for (const row of fkRows as unknown as Array<Record<string, unknown>>) {
      const name = String(row.constraintName);
      const entry = fkMap.get(name) ?? { ref: `${String(row.refSchema)}.${String(row.refTable)}`, columns: [], refColumns: [] };
      entry.columns.push(String(row.columnName));
      entry.refColumns.push(String(row.refColumn));
      fkMap.set(name, entry);
    }

    let rowCount: number | null = null;
    try {
      const [countRows] = await pool.query<RowDataPacket[]>({ sql: `SELECT CAST(COUNT(*) AS SIGNED) AS n FROM ??`, values: [`${db}.${table}`] }, []);
      rowCount = optNumber((countRows as unknown as Array<Record<string, unknown>>)[0]?.n);
    } catch {
      rowCount = null;
    }

    return {
      database: db,
      schema: db,
      name: table,
      type: 'BASE TABLE',
      rowCount,
      columns,
      indexes,
      foreignKeys: [...fkMap.entries()].map(([name, entry]) => ({
        name,
        columns: entry.columns.join(', '),
        referencedTable: entry.ref,
        referencedColumns: entry.refColumns.join(', '),
      })),
    };
  }

  async runQuery(database: string | undefined, sqlText: string, maxRows: number, mode: 'read' | 'write'): Promise<QueryOutput> {
    if (mode === 'read') assertReadOnly(sqlText, 'explain');
    if (!sqlText || sqlText.trim() === '') throw new Error('La sentencia está vacía.');

    const db = await this.resolveDatabase(database);
    const rowLimit = Math.min(maxRows, 5000);
    const pool = await this.poolFor(db);
    const started = performance.now();

    try {
      const connection = await pool.getConnection();
      try {
        const [rows, fields] = await connection.query({ sql: sqlText, timeout: this.limits.queryTimeoutMs });
        const elapsedMs = Math.round(performance.now() - started);
        if (Array.isArray(rows)) {
          const limited = (rows as Array<Record<string, unknown>>).slice(0, rowLimit);
          const columns = Array.isArray(fields) ? fields.map((field) => field.name) : undefined;
          const recordset = rowsToPlain(limited, columns);
          return {
            database: db,
            rowLimit,
            rowLimitReached: (rows as unknown[]).length > rowLimit,
            elapsedMs,
            rowsAffected: [],
            recordsets: [recordset],
          };
        }
        const affected = (rows as { affectedRows?: number }).affectedRows ?? 0;
        return { database: db, rowLimit, rowLimitReached: false, elapsedMs, rowsAffected: [affected], recordsets: [] };
      } finally {
        connection.release();
      }
    } catch (error) {
      throw describeMysqlError(error);
    }
  }

  async close(): Promise<void> {
    const pending = [...this.pools.values()];
    this.pools.clear();
    await Promise.allSettled(
      pending.map(async (entry) => {
        try {
          await (await entry).end();
        } catch {
          // Pool que nunca conectó.
        }
      }),
    );
  }
}
