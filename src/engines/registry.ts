import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AppConfig } from '../config.js';
import { dataHome, loadConfig } from '../config.js';
import { log } from '../logger.js';
import { ENGINES } from './types.js';
import type { ConnectionProfile, EngineAdapter, EngineKind } from './types.js';
import { MssqlAdapter } from './mssql.js';
import { MysqlAdapter } from './mysql.js';
import { PostgresAdapter } from './postgres.js';

/** Archivo donde el agente guarda conexiones propias (no va al repositorio). */
export const savedConnectionsPath = join(dataHome, 'connections.json');

type AdapterLimits = { maxRows: number; queryTimeoutMs: number; connectTimeoutMs: number; readOnly: boolean };

function isEngine(value: unknown): value is EngineKind {
  return value === 'mssql' || value === 'mysql' || value === 'postgres';
}

function readJsonFile(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { connections?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const list = Array.isArray(parsed) ? parsed : (parsed.connections ?? []);
    return Array.isArray(list) ? list : [];
  } catch (error) {
    log.warn(`No se pudo leer ${path}`, error instanceof Error ? error.message : error);
    return [];
  }
}

/** Normaliza una entrada escrita a mano o por el agente. Lanza si le falta lo esencial. */
function normalizeProfile(raw: Record<string, unknown>, origin: string, defaults: AppConfig): ConnectionProfile {
  const name = String(raw.name ?? '').trim();
  if (!name) throw new Error(`${origin}: hay una conexión sin "name".`);

  const engineValue = raw.engine ?? defaults.engine;
  if (!isEngine(engineValue)) {
    throw new Error(`${origin}: la conexión "${name}" tiene engine inválido (${String(engineValue)}); usa mssql|mysql|postgres.`);
  }
  const engine = engineValue;

  const options: Record<string, string | number | boolean | null> = {};
  const rawOptions = raw.options;
  if (rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions)) {
    for (const [key, value] of Object.entries(rawOptions as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
        options[key] = value;
      }
    }
  }

  const portValue = raw.port === undefined || raw.port === null || raw.port === '' ? undefined : Number(raw.port);
  return {
    name,
    engine,
    host: String(raw.host ?? '').trim() || defaults.server,
    port: portValue !== undefined && Number.isInteger(portValue) ? portValue : ENGINES[engine].defaultPort,
    database: String(raw.database ?? '').trim() || (engine === 'mssql' ? 'master' : engine === 'mysql' ? 'mysql' : 'postgres'),
    user: String(raw.user ?? '').trim(),
    password: String(raw.password ?? ''),
    options,
    origin,
  };
}

/**
 * Resuelve la conexión pedida y construye su adaptador de motor.
 * Fuentes, de mayor a menor prioridad: conexiones guardadas por el agente
 * (dataHome), `MSSQL_CONFIGS` (declaradas) y el `.env` (por defecto).
 */
export class ConnectionRegistry {
  private readonly defaults: AppConfig;
  private readonly declared: ConnectionProfile[];
  private readonly saved: ConnectionProfile[];

  constructor(configs: AppConfig) {
    this.defaults = configs;
    this.declared = this.readProfiles(configs.configsPath, 'configs');
    this.saved = this.readProfiles(savedConnectionsPath, 'saved');
  }

  private readProfiles(path: string, origin: string): ConnectionProfile[] {
    const profiles: ConnectionProfile[] = [];
    for (const raw of readJsonFile(path)) {
      try {
        const profile = normalizeProfile(raw, origin, this.defaults);
        profiles.push({ ...profile, origin });
      } catch (error) {
        log.warn(error instanceof Error ? error.message : String(error));
      }
    }
    return profiles;
  }

  /** Perfil del `.env`, siempre disponible como "default". */
  private defaultProfile(): ConnectionProfile {
    return {
      name: 'default',
      engine: this.defaults.engine,
      host: this.defaults.server,
      port: this.defaults.port,
      database: this.defaults.database,
      user: this.defaults.user,
      password: this.defaults.password,
      options: {
        encrypt: this.defaults.encrypt,
        trustServerCertificate: this.defaults.trustServerCertificate,
      },
      origin: 'env',
    };
  }

  list(): ConnectionProfile[] {
    const byName = new Map<string, ConnectionProfile>();
    byName.set('default', this.defaultProfile());
    for (const profile of [...this.declared, ...this.saved]) byName.set(profile.name.toLowerCase(), { ...profile });
    return [...byName.values()].map((profile) => ({ ...profile, password: profile.password ? '***' : '' }));
  }

  /** Descripción compacta sin secretos, para que el agente elija. */
  summarize() {
    return this.list().map((profile) => ({
      name: profile.name,
      engine: profile.engine,
      host: profile.host,
      port: profile.port,
      database: profile.database,
      user: profile.user,
      origin: profile.origin,
      hasPassword: profile.password !== '',
    }));
  }

  resolve(requested?: string, engineOverride?: EngineKind): ConnectionProfile {
    const wanted = requested?.trim();
    const fallbackEngine = engineOverride ?? this.defaults.engine;

    if (!wanted) {
      const profile = { ...this.defaultProfile() };
      profile.engine = engineOverride ?? profile.engine;
      if (profile.engine !== this.defaults.engine && engineOverride === profile.engine) {
        profile.port = ENGINES[profile.engine].defaultPort;
        profile.database = ENGINES[profile.engine].systemDatabase;
      }
      this.assertCredentials(profile);
      return profile;
    }

    const candidates = [this.defaultProfile(), ...this.declared, ...this.saved].filter(
      (profile) => profile.name.toLowerCase() === wanted.toLowerCase(),
    );
    const profile = candidates.at(-1);
    if (!profile) {
      const names = this.list().map((entry) => entry.name).sort();
      throw new Error(`No existe la conexión "${wanted}". Disponibles: ${names.join(', ')}.`);
    }
    if (engineOverride && engineOverride !== profile.engine) {
      throw new Error(
        `La conexión "${profile.name}" es de motor ${profile.engine}; no puedes forzar ${engineOverride}. ` +
          'Crea otra conexión con el motor correcto.',
      );
    }
    this.assertCredentials(profile);
    return profile;
  }

  private assertCredentials(profile: ConnectionProfile): void {
    if (!profile.user || !profile.password) {
      throw new Error(
        `Faltan credenciales para la conexión "${profile.name}" (motor ${profile.engine}). ` +
          'Define MSSQL_USER/MSSQL_PASSWORD en el .env, o crea una conexión con save_connection.',
      );
    }
  }

  create(profile: ConnectionProfile): EngineAdapter {
    const limits: AdapterLimits = {
      maxRows: this.defaults.maxRows,
      queryTimeoutMs: this.defaults.queryTimeoutMs,
      connectTimeoutMs: this.defaults.connectTimeoutMs,
      readOnly: this.defaults.readOnly,
    };
    switch (profile.engine) {
      case 'mssql':
        return new MssqlAdapter(profile, limits);
      case 'mysql':
        return new MysqlAdapter(profile, limits);
      case 'postgres':
        return new PostgresAdapter(profile, limits);
    }
  }

  /** Guarda o reemplaza una conexión en el archivo de datos del usuario. */
  save(input: {
    name: string;
    engine: EngineKind;
    host?: string;
    port?: number;
    database?: string;
    user: string;
    password: string;
    options?: Record<string, string | number | boolean | null>;
  }): ConnectionProfile {
    const profile = normalizeProfile(
      {
        name: input.name,
        engine: input.engine,
        host: input.host,
        port: input.port,
        database: input.database,
        user: input.user,
        password: input.password,
        options: input.options,
      },
      'saved',
      { ...loadConfig(), engine: input.engine },
    );

    const existing = readJsonFile(savedConnectionsPath).filter(
      (entry) => String(entry.name ?? '').toLowerCase() !== profile.name.toLowerCase(),
    );
    existing.push({
      name: profile.name,
      engine: profile.engine,
      host: profile.host,
      port: profile.port,
      database: profile.database,
      user: profile.user,
      password: profile.password,
      options: profile.options,
    });

    mkdirSync(dataHome, { recursive: true });
    writeFileSync(savedConnectionsPath, `${JSON.stringify({ connections: existing }, null, 2)}\n`, 'utf8');
    return profile;
  }

  remove(name: string): boolean {
    const entries = readJsonFile(savedConnectionsPath);
    const kept = entries.filter((entry) => String(entry.name ?? '').toLowerCase() !== name.toLowerCase());
    if (kept.length === entries.length) return false;
    writeFileSync(savedConnectionsPath, `${JSON.stringify({ connections: kept }, null, 2)}\n`, 'utf8');
    return true;
  }

  get engineLabels(): Array<{ engine: EngineKind; label: string; defaultPort: number }> {
    return Object.values(ENGINES).map((info) => ({
      engine: info.kind,
      label: info.label,
      defaultPort: info.defaultPort,
    }));
  }
}
