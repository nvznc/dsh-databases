/** Motores soportados por el MCP. */
export type EngineKind = 'mssql' | 'mysql' | 'postgres';

export interface EngineInfo {
  kind: EngineKind;
  label: string;
  defaultPort: number;
  /** Nombre de la base "de sistema"/catálogo usada para listar el resto. */
  systemDatabase: string;
}

export const ENGINES: Record<EngineKind, EngineInfo> = {
  mssql: { kind: 'mssql', label: 'Microsoft SQL Server', defaultPort: 1433, systemDatabase: 'master' },
  mysql: { kind: 'mysql', label: 'MySQL / MariaDB', defaultPort: 3306, systemDatabase: 'mysql' },
  postgres: { kind: 'postgres', label: 'PostgreSQL', defaultPort: 5432, systemDatabase: 'postgres' },
};

export interface ConnectionProfile {
  /** Nombre estable con el que el agente elige la conexión. */
  name: string;
  engine: EngineKind;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** Mapa de parámetros del motor (encrypt, ssl, etc.). */
  options: Record<string, string | number | boolean | null>;
  /** Origen del perfil: .env, archivo de conexiones o creado por el agente. */
  origin?: string;
}

export interface DatabaseInfo {
  name: string;
  sizeMb?: number | null;
  extra?: Record<string, unknown>;
}

/** Permite elegir conexión por argumento o por la variable DSH_MCP_SQL_CONNECTION. */
export function chooseConnection(requested?: string): string | undefined {
  const explicit = requested?.trim();
  if (explicit) return explicit;
  const fromEnv = process.env.DSH_MCP_SQL_CONNECTION?.trim();
  return fromEnv ? fromEnv : undefined;
}

export interface TableSummary {
  schema: string;
  name: string;
  type: 'table' | 'view';
  rowCount: number | null;
  createdAt?: string | null;
  modifiedAt?: string | null;
}

export interface TableDescription {
  database: string;
  schema: string;
  name: string;
  type: string;
  rowCount: number | null;
  columns: Array<{
    ordinal: number;
    name: string;
    dataType: string;
    typeArgs: string | null;
    nullable: boolean;
    defaultValue: string | null;
    identity: boolean;
    extra?: string | null;
  }>;
  indexes: Array<{
    name: string;
    unique: boolean;
    primary: boolean;
    columns: string;
  }>;
  foreignKeys: Array<{
    name: string;
    columns: string;
    referencedTable: string;
    referencedColumns: string;
  }>;
}

export interface QueryOutput {
  database: string;
  rowLimit: number;
  rowLimitReached: boolean;
  elapsedMs: number;
  rowsAffected: number[];
  recordsets: Array<{
    columns: string[];
    rowCount: number;
    rows: Array<Record<string, unknown>>;
  }>;
}

/** Contrato que implementa cada motor. */
export interface EngineAdapter {
  readonly kind: EngineKind;
  /** Ping directo; lanza un error legible si no conecta. */
  ping(database?: string): Promise<void>;
  /** Info del servidor para diagnóstico. */
  serverInfo(): Promise<Record<string, unknown>>;
  listDatabases(includeSystem: boolean): Promise<DatabaseInfo[]>;
  resolveDatabase(requested?: string): Promise<string>;
  listTables(
    database: string | undefined,
    options: { schema?: string; nameContains?: string; kind?: 'all' | 'tables' | 'views' },
  ): Promise<{ database: string; tables: TableSummary[] }>;
  describeTable(database: string | undefined, schema: string, table: string): Promise<TableDescription>;
  runQuery(database: string | undefined, sql: string, maxRows: number, mode: 'read' | 'write'): Promise<QueryOutput>;
  close(): Promise<void>;
}
