import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EngineKind } from './engines/types.js';
import type { LogLevel } from './logger.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** Raíz del paquete (dist/ -> ..): aquí viven los configs por defecto. */
export const projectRoot = resolve(moduleDir, '..');

/** Directorio de datos: `DSH_MCP_SQL_HOME` o `~/.dsh-mcp-sql`. Guarda conexiones creadas por el agente. */
export const dataHome = resolve(process.env.DSH_MCP_SQL_HOME?.trim() || join(homedir(), '.dsh-mcp-sql'));

/**
 * Carga .env sin dependencias externas. No sobreescribe variables ya definidas
 * en el entorno, de modo que DSH (o la shell) siempre pueden inyectar overrides.
 */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;

  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);

    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(resolve(projectRoot, '.env'));
loadDotEnv(resolve(projectRoot, '.env.local'));
loadDotEnv(join(dataHome, '.env'));

/** Ruta preferida de las conexiones declaradas (MSSQL_CONFIGS). */
export const defaultConfigsPath = resolve(projectRoot, 'configs', 'connections.json');

export interface AppConfig {
  /** Motor por defecto cuando ni la herramienta ni la conexión lo especifican. */
  engine: EngineKind;
  /** Credenciales por defecto (vienen del .env y valen para cualquier motor). */
  server: string;
  port: number;
  database: string;
  user: string;
  password: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  /** Cuando es true, `run_query` solo acepta consultas de lectura. */
  readOnly: boolean;
  /** Habilita la herramienta `execute_sql` (escritura arbitraria). */
  allowWrite: boolean;
  /** Filas máximas devueltas por consulta cuando la herramienta no lo indica. */
  maxRows: number;
  queryTimeoutMs: number;
  connectTimeoutMs: number;
  /** Lista blanca de bases de datos; vacía = todas las accesibles. */
  allowedDatabases: string[];
  /** Archivo JSON con las conexiones declaradas. */
  configsPath: string;
  logLevel: LogLevel;
}

const ENGINES: EngineKind[] = ['mssql', 'mysql', 'postgres'];

function str(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function optionalStr(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function bool(name: string, fallback: boolean): boolean {
  const raw = optionalStr(name);
  if (raw === undefined) return fallback;
  const value = raw.toLowerCase();
  if (['1', 'true', 'yes', 'y', 'si', 'sí', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(value)) return false;
  throw new Error(`Valor booleano inválido en ${name}: "${raw}"`);
}

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = optionalStr(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Valor numérico inválido en ${name}: "${raw}" (entero entre ${min} y ${max})`);
  }
  return value;
}

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function resolvePath(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const expanded = value.startsWith('~') ? join(homedir(), value.slice(1).replace(/^[\\/]/, '')) : value;
  return isAbsolute(expanded) ? expanded : resolve(projectRoot, expanded);
}

/**
 * Valida lo que no depende de credenciales. El arranque no falla si faltan
 * usuario/contraseña: ese error se informa en cada llamada a herramienta, y
 * otras fuentes (conexiones declaradas) pueden aportarlas.
 */
export function loadConfig(): AppConfig {
  const engineRaw = str('MSSQL_ENGINE', 'mssql').toLowerCase();
  if (!ENGINES.includes(engineRaw as EngineKind)) {
    throw new Error(`MSSQL_ENGINE inválido: "${engineRaw}" (usa ${ENGINES.join('|')})`);
  }

  const logLevelRaw = str('MSSQL_LOG_LEVEL', 'info').toLowerCase();
  if (!LOG_LEVELS.includes(logLevelRaw as LogLevel)) {
    throw new Error(`MSSQL_LOG_LEVEL inválido: "${logLevelRaw}" (usa debug|info|warn|error)`);
  }

  const allowedDatabases = str('MSSQL_ALLOWED_DATABASES', '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const readOnly = bool('MSSQL_READ_ONLY', true);
  const allowWrite = bool('MSSQL_ALLOW_WRITE', false);

  return {
    engine: engineRaw as EngineKind,
    server: str('MSSQL_SERVER', 'localhost'),
    port: int('MSSQL_PORT', 1433, 1, 65535),
    database: str('MSSQL_DATABASE', 'master'),
    user: optionalStr('MSSQL_USER') ?? '',
    password: process.env.MSSQL_PASSWORD ?? '',
    encrypt: bool('MSSQL_ENCRYPT', true),
    trustServerCertificate: bool('MSSQL_TRUST_SERVER_CERTIFICATE', true),
    readOnly: readOnly && !allowWrite,
    allowWrite,
    maxRows: int('MSSQL_MAX_ROWS', 200, 1, 5000),
    queryTimeoutMs: int('MSSQL_QUERY_TIMEOUT_MS', 30_000, 1_000, 600_000),
    connectTimeoutMs: int('MSSQL_CONNECT_TIMEOUT_MS', 15_000, 1_000, 120_000),
    allowedDatabases,
    configsPath: resolvePath(optionalStr('MSSQL_CONFIGS'), defaultConfigsPath),
    logLevel: logLevelRaw as LogLevel,
  };
}
