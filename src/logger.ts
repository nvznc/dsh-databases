/**
 * Logger mÃ­nimo que escribe SIEMPRE en stderr.
 * stdout estÃ¡ reservado para el protocolo MCP (JSON-RPC), cualquier log ahÃ­ lo rompe.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = LEVELS.info;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level];
}

function write(level: LogLevel, message: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const suffix = extra === undefined ? '' : ` ${safeStringify(extra)}`;
  process.stderr.write(`[${new Date().toISOString()}] ${level.toUpperCase()} dsh-databases: ${message}${suffix}\n`);
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (message: string, extra?: unknown) => write('debug', message, extra),
  info: (message: string, extra?: unknown) => write('info', message, extra),
  warn: (message: string, extra?: unknown) => write('warn', message, extra),
  error: (message: string, extra?: unknown) => write('error', message, extra),
};
