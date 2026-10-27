import { performance } from 'node:perf_hooks';

import sql from 'mssql';

import { assertReadOnly } from '../guard.js';
import { log } from '../logger.js';
import { rowsToPlain } from './shared.js';
import type { ConnectionProfile, DatabaseInfo, EngineAdapter, QueryOutput, TableDescription, TableSummary } from './types.js';

interface RawRecordset extends Array<Record<string, unknown>> {
  columns?: Record<string, unknown>;
}

function bracket(identifier: string): string {
  return `[${identifier.replace(/]/g, ']]')}]`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_[\]]/g, (match) => `\\${match}`);
}

function optNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Traduce errores crudos de tedious/mssql a mensajes accionables en español. */
export function describeDbError(error: unknown): Error {
  const err = error as {
    message?: string;
    code?: string;
    number?: number;
    lineNumber?: number;
    originalError?: { message?: string; code?: string; number?: number };
  };

  const code = err?.code ?? err?.originalError?.code;
  const number = err?.number ?? err?.originalError?.number;
  const message = err?.message ?? err?.originalError?.message ?? String(error);

  const hints: Record<string, string> = {
    ELOGIN:
      'Login fallido. Revisa usuario/contraseña (MSSQL_USER, MSSQL_PASSWORD o la conexión elegida) y que el login tenga acceso a la base.',
    ESOCKET:
      'No se pudo abrir la conexión TCP. Verifica host/puerto (MSSQL_SERVER/MSSQL_PORT) y que TCP/IP esté habilitado.',
    ECONNCLOSED:
      'SQL Server cerró la conexión. Suele ser TLS: prueba MSSQL_TRUST_SERVER_CERTIFICATE=true o MSSQL_ENCRYPT=false.',
    ETIMEOUT: 'Se agotó el tiempo de espera. Sube MSSQL_QUERY_TIMEOUT_MS o simplifica la consulta.',
    ENOTOPEN: 'La conexión no está abierta.',
  };

  const parts = [message];
  if (number !== undefined) {
    parts.push(`(error ${number}${code ? `, ${code}` : ''}${err.lineNumber ? `, línea ${err.lineNumber}` : ''})`);
  }
  if (code && hints[code]) parts.push(`→ ${hints[code]}`);

  const wrapped = new Error(parts.join(' '));
  wrapped.cause = error;
  return wrapped;
}

/** Motor SQL Server: un pool por base de datos dentro de la misma conexión lógica. */
export class MssqlAdapter implements EngineAdapter {
  readonly kind = 'mssql' as const;
  private readonly pools = new Map<string, Promise<sql.ConnectionPool>>();

  constructor(
    private readonly profile: ConnectionProfile,
    private readonly limits: { maxRows: number; queryTimeoutMs: number; connectTimeoutMs: number; readOnly: boolean },
  ) {}

  get engineLabel(): string {
    return 'Microsoft SQL Server';
  }

  private buildPoolConfig(database: string): sql.config {
    const options = this.profile.options;
    const encrypt = options.encrypt ?? true;
    const trust = options.trustServerCertificate ?? options.trust_cert ?? true;
    return {
      server: this.profile.host,
      port: this.profile.port,
      database,
      user: this.profile.user,
      password: this.profile.password,
      connectionTimeout: optNumber(options.connectTimeout) !== null ? Number(options.connectTimeout) : this.limits.connectTimeoutMs,
      requestTimeout: optNumber(options.requestTimeout) !== null ? Number(options.requestTimeout) : this.limits.queryTimeoutMs,
      options: {
        encrypt: Boolean(encrypt),
        trustServerCertificate: Boolean(trust),
        enableArithAbort: true,
        appName: 'mcp-databases',
      },
      pool: { max: 5, min: 0, idleTimeoutMillis: 30_000 },
    };
  }

  private async poolFor(database: string): Promise<sql.ConnectionPool> {
    const key = database.toLowerCase();
    const cached = this.pools.get(key);
    if (cached) return cached;

    const pending = (async () => {
      const pool = new sql.ConnectionPool(this.buildPoolConfig(database));
      pool.on('error', (error) => log.error(`Error en el pool de "${database}"`, describeDbError(error)));
      try {
        await pool.connect();
        return pool;
      } catch (error) {
        await pool.close().catch(() => undefined);
        throw describeDbError(error);
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

  private async systemPool(): Promise<sql.ConnectionPool> {
    return this.poolFor('master');
  }

  async ping(): Promise<void> {
    const pool = await this.systemPool();
    await pool.request().query('SELECT 1 AS ok');
  }

  async databaseNames(): Promise<string[]> {
    const pool = await this.systemPool();
    const result = await pool
      .request()
      .query<{ name: string }>('SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY name');
    return result.recordset.map((row) => row.name);
  }

  async resolveDatabase(requested?: string): Promise<string> {
    const wanted = (requested ?? this.profile.database ?? 'master').trim();
    if (wanted === '') throw new Error('El nombre de la base de datos está vacío.');
    const names = await this.databaseNames();
    const match = names.find((name) => name.toLowerCase() === wanted.toLowerCase());
    if (!match) {
      throw new Error(`No existe la base "${wanted}" o el login no tiene acceso. Accesibles: ${names.join(', ')}.`);
    }
    return match;
  }

  async serverInfo(): Promise<Record<string, unknown>> {
    const pool = await this.systemPool();
    const result = await pool.request().query<Record<string, unknown>>(`
      SELECT
        @@SERVERNAME AS serverName,
        CAST(SERVERPROPERTY('ProductVersion') AS varchar(64))  AS productVersion,
        CAST(SERVERPROPERTY('ProductLevel')   AS varchar(64))  AS productLevel,
        CAST(SERVERPROPERTY('Edition')        AS varchar(128)) AS edition,
        CAST(SERVERPROPERTY('MachineName')    AS varchar(128)) AS machineName,
        CAST(SERVERPROPERTY('InstanceName')   AS varchar(128)) AS instanceName,
        CONVERT(varchar(19), si.sqlserver_start_time, 120) AS startedAt,
        SUSER_SNAME() AS currentLogin,
        DB_NAME()     AS currentDatabase
      FROM sys.dm_os_sys_info si
    `);
    return rowsToPlain(result.recordset).rows[0] ?? {};
  }

  async listDatabases(includeSystem: boolean): Promise<DatabaseInfo[]> {
    const pool = await this.systemPool();
    const request = pool.request();
    request.input('includeSystem', sql.Bit, includeSystem ? 1 : 0);
    const result = await request.query<{
      name: string;
      state: string;
      recoveryModel: string;
      compatibilityLevel: number;
      isReadOnly: boolean;
      createdAt: string;
      sizeMb: number | null;
    }>(`
      SELECT
        d.name                        AS name,
        d.state_desc                  AS state,
        d.recovery_model_desc         AS recoveryModel,
        d.compatibility_level         AS compatibilityLevel,
        d.is_read_only                AS isReadOnly,
        CONVERT(varchar(19), d.create_date, 120) AS createdAt,
        CAST(SUM(CAST(mf.size AS bigint)) * 8.0 / 1024 AS decimal(12, 1)) AS sizeMb
      FROM sys.databases d
      LEFT JOIN sys.master_files mf ON mf.database_id = d.database_id
      WHERE (@includeSystem = 1 OR d.database_id > 4)
        AND HAS_DBACCESS(d.name) = 1
      GROUP BY d.name, d.state_desc, d.recovery_model_desc, d.compatibility_level, d.is_read_only, d.create_date
      ORDER BY d.name
    `);
    return result.recordset.map((row) => ({ name: row.name, sizeMb: optNumber(row.sizeMb), extra: { ...row } }));
  }

  async listTables(
    database: string | undefined,
    options: { schema?: string; nameContains?: string; kind?: 'all' | 'tables' | 'views' },
  ): Promise<{ database: string; tables: TableSummary[] }> {
    const db = await this.resolveDatabase(database);
    const kind = options.kind ?? 'all';
    const pool = await this.poolFor(db);
    const request = pool.request();
    request.input('schema', sql.NVarChar(128), options.schema ?? null);
    request.input(
      'nameLike',
      sql.NVarChar(256),
      options.nameContains ? `%${escapeLike(options.nameContains)}%` : null,
    );
    request.input('includeTables', sql.Bit, kind === 'views' ? 0 : 1);
    request.input('includeViews', sql.Bit, kind === 'tables' ? 0 : 1);

    const result = await request.query<TableSummary>(`
      SELECT
        s.name                     AS [schema],
        o.name                     AS name,
        CASE o.type WHEN 'U' THEN 'table' ELSE 'view' END AS type,
        CASE WHEN o.type = 'U' THEN (
          SELECT CAST(SUM(p.rows) AS int)
          FROM sys.partitions p
          WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)
        ) ELSE NULL END           AS [rowCount],
        CONVERT(varchar(19), o.create_date, 120) AS createdAt,
        CONVERT(varchar(19), o.modify_date, 120) AS modifiedAt
      FROM sys.objects o
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE o.is_ms_shipped = 0
        AND o.type IN ('U', 'V')
        AND (@includeTables = 1 OR o.type = 'V')
        AND (@includeViews = 1 OR o.type = 'U')
        AND (@schema IS NULL OR s.name = @schema)
        AND (@nameLike IS NULL OR o.name LIKE @nameLike ESCAPE '\\')
      ORDER BY s.name, o.name
    `);
    return { database: db, tables: result.recordset };
  }

  async describeTable(database: string | undefined, schema: string, table: string): Promise<TableDescription> {
    const db = await this.resolveDatabase(database);
    const fullName = `${bracket(schema)}.${bracket(table)}`;
    const pool = await this.poolFor(db);

    const objectResult = await pool
      .request()
      .input('schema', sql.NVarChar(128), schema)
      .input('table', sql.NVarChar(128), table)
      .query<{ objectId: number; type: string }>(`
        SELECT o.object_id AS objectId, o.type_desc AS type
        FROM sys.objects o
        JOIN sys.schemas s ON s.schema_id = o.schema_id
        WHERE s.name = @schema AND o.name = @table AND o.type IN ('U', 'V')
      `);

    const target = objectResult.recordset[0];
    if (!target) throw new Error(`No existe la tabla o vista ${fullName} en la base "${db}".`);

    const columns = await pool.request().input('objectName', sql.NVarChar(512), fullName).query<{
      ordinal: number;
      name: string;
      dataType: string;
      typeArgs: string | null;
      nullable: boolean;
      defaultValue: string | null;
      identity: boolean;
      collation: string | null;
    }>(`
      SELECT
        c.column_id AS ordinal,
        c.name      AS name,
        t.name      AS dataType,
        CASE
          WHEN t.name IN ('nvarchar', 'nchar') AND c.max_length = -1 THEN 'max'
          WHEN t.name IN ('varchar', 'char', 'varbinary', 'binary') AND c.max_length = -1 THEN 'max'
          WHEN t.name IN ('nvarchar', 'nchar') THEN CAST(c.max_length / 2 AS varchar(10))
          WHEN t.name IN ('varchar', 'char', 'varbinary', 'binary') THEN CAST(c.max_length AS varchar(10))
          WHEN t.name IN ('decimal', 'numeric') THEN CAST(c.precision AS varchar(10)) + ',' + CAST(c.scale AS varchar(10))
          WHEN t.name IN ('datetime2', 'datetimeoffset', 'time') THEN CAST(c.scale AS varchar(10))
          ELSE NULL
        END AS typeArgs,
        c.is_nullable AS nullable,
        dc.definition AS defaultValue,
        c.is_identity AS [identity],
        c.collation_name AS collation
      FROM sys.columns c
      JOIN sys.types t ON t.user_type_id = c.user_type_id
      LEFT JOIN sys.default_constraints dc
        ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
      WHERE c.object_id = OBJECT_ID(@objectName)
      ORDER BY c.column_id
    `);

    const indexes = await pool.request().input('objectName', sql.NVarChar(512), fullName).query<{
      name: string;
      type: string;
      isUnique: boolean;
      isPrimaryKey: boolean;
      keyColumns: string | null;
      includedColumns: string | null;
    }>(`
      SELECT
        i.name          AS name,
        i.type_desc     AS type,
        i.is_unique     AS isUnique,
        i.is_primary_key AS isPrimaryKey,
        STUFF((
          SELECT ', ' + c.name
          FROM sys.index_columns ic
          JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
          WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
          ORDER BY ic.key_ordinal
          FOR XML PATH(''), TYPE
        ).value('.', 'nvarchar(max)'), 1, 2, '') AS keyColumns,
        STUFF((
          SELECT ', ' + c.name
          FROM sys.index_columns ic
          JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
          WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 1
          ORDER BY ic.index_column_id
          FOR XML PATH(''), TYPE
        ).value('.', 'nvarchar(max)'), 1, 2, '') AS includedColumns
      FROM sys.indexes i
      WHERE i.object_id = OBJECT_ID(@objectName) AND i.name IS NOT NULL
      ORDER BY i.is_primary_key DESC, i.name
    `);

    const fks = await pool.request().input('objectName', sql.NVarChar(512), fullName).query<{
      name: string;
      referencedTable: string;
      columns: string | null;
      referencedColumns: string | null;
    }>(`
      SELECT
        fk.name AS name,
        OBJECT_SCHEMA_NAME(fk.referenced_object_id) + '.' + OBJECT_NAME(fk.referenced_object_id) AS referencedTable,
        STUFF((
          SELECT ', ' + pc.name
          FROM sys.foreign_key_columns fkc
          JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
          WHERE fkc.constraint_object_id = fk.object_id
          ORDER BY fkc.constraint_column_id
          FOR XML PATH(''), TYPE
        ).value('.', 'nvarchar(max)'), 1, 2, '') AS columns,
        STUFF((
          SELECT ', ' + rc.name
          FROM sys.foreign_key_columns fkc
          JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
          WHERE fkc.constraint_object_id = fk.object_id
          ORDER BY fkc.constraint_column_id
          FOR XML PATH(''), TYPE
        ).value('.', 'nvarchar(max)'), 1, 2, '') AS referencedColumns
      FROM sys.foreign_keys fk
      WHERE fk.parent_object_id = OBJECT_ID(@objectName)
      ORDER BY fk.name
    `);

    let rowCount: number | null = null;
    if (target.type.startsWith('USER_TABLE')) {
      const count = await pool.request().input('objectName', sql.NVarChar(512), fullName).query<{ rowCount: number | null }>(`
        SELECT CAST(SUM(p.rows) AS int) AS [rowCount]
        FROM sys.partitions p
        WHERE p.object_id = OBJECT_ID(@objectName) AND p.index_id IN (0, 1)
      `);
      rowCount = count.recordset[0]?.rowCount ?? null;
    }

    return {
      database: db,
      schema,
      name: table,
      type: target.type,
      rowCount,
      columns: columns.recordset.map((column) => ({
        ordinal: column.ordinal,
        name: column.name,
        dataType: column.dataType,
        typeArgs: column.typeArgs,
        nullable: column.nullable,
        defaultValue: column.defaultValue,
        identity: column.identity,
        extra: column.collation,
      })),
      indexes: indexes.recordset.map((index) => ({
        name: `${index.name} (${index.type})`,
        unique: index.isUnique,
        primary: index.isPrimaryKey,
        columns: [index.keyColumns, index.includedColumns ? `incluye: ${index.includedColumns}` : null]
          .filter(Boolean)
          .join(' — '),
      })),
      foreignKeys: fks.recordset.map((fk) => ({
        name: fk.name,
        columns: fk.columns ?? '',
        referencedTable: fk.referencedTable,
        referencedColumns: fk.referencedColumns ?? '',
      })),
    };
  }

  async runQuery(database: string | undefined, sqlText: string, maxRows: number, mode: 'read' | 'write'): Promise<QueryOutput> {
    if (mode === 'read') assertReadOnly(sqlText);
    if (!sqlText || sqlText.trim() === '') throw new Error('La sentencia está vacía.');

    const db = await this.resolveDatabase(database);
    const rowLimit = Math.min(maxRows, 5000);
    const pool = await this.poolFor(db);

    // El lote separa los datos: SET ROWCOUNT acota las filas leídas.
    const batch = `SET NOCOUNT ON;\nSET ROWCOUNT ${rowLimit};\n${sqlText}\n;SET ROWCOUNT 0;`;
    const started = performance.now();

    let result: sql.IResult<unknown>;
    try {
      result = await pool.request().query(batch);
    } catch (error) {
      throw describeDbError(error);
    }

    const elapsedMs = Math.round(performance.now() - started);
    const raw = (result.recordsets ?? []) as unknown as RawRecordset[];
    const recordsets = raw.map((recordset) =>
      rowsToPlain(recordset as Array<Record<string, unknown>>, recordset.columns ? Object.keys(recordset.columns) : undefined),
    );

    return {
      database: db,
      rowLimit,
      rowLimitReached: recordsets.some((recordset) => recordset.rowCount >= rowLimit),
      elapsedMs,
      rowsAffected: result.rowsAffected ?? [],
      recordsets,
    };
  }

  async close(): Promise<void> {
    const pending = [...this.pools.values()];
    this.pools.clear();
    await Promise.allSettled(
      pending.map(async (entry) => {
        try {
          await (await entry).close();
        } catch {
          // Pool que nunca conectó: nada que cerrar.
        }
      }),
    );
  }
}
