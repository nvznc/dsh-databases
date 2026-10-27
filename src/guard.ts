/**
 * Guarda de solo lectura para consultas de cualquier motor SQL.
 *
 * No es un parser completo: enmascara comentarios, literales ('...' y "..."),
 * e identificadores entre comillas dobles/backticks/corchetes, y luego valida
 * la forma de la sentencia. La ejecución real, además, ocurre con límite de
 * filas y timeout, y el login debe tener permisos de solo lectura.
 */
export class SqlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlGuardError';
  }
}

const FORBIDDEN_KEYWORDS =
  /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|deny|execute|exec|call|backup|restore|shutdown|kill|dbcc|bulk|into|openrowset|openquery|opendatasource|sp_executesql|xp_cmdshell|pg_sleep|lo_import|lo_export|copy|vacuum|analyze)\b/i;

/**
 * Devuelve el texto con comentarios eliminados y literales/identificadores
 * citados reducidos a `''`, conservando puntos y comas para separar sentencias.
 */
function mask(sqlText: string): string {
  let out = '';
  let i = 0;

  while (i < sqlText.length) {
    const ch = sqlText[i]!;
    const next = sqlText[i + 1];

    if (ch === '-' && next === '-') {
      while (i < sqlText.length && sqlText[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }

    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < sqlText.length && depth > 0) {
        if (sqlText[i] === '/' && sqlText[i + 1] === '*') {
          depth += 1;
          i += 2;
          continue;
        }
        if (sqlText[i] === '*' && sqlText[i + 1] === '/') {
          depth -= 1;
          i += 2;
          continue;
        }
        i += 1;
      }
      if (depth > 0) throw new SqlGuardError('Comentario /* ... */ sin cerrar.');
      out += ' ';
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      let closed = false;
      while (i < sqlText.length) {
        if (sqlText[i] === '\\' && quote !== '"') {
          i += 2;
          continue;
        }
        if (sqlText[i] === quote) {
          if (sqlText[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) throw new SqlGuardError(`Literal ${quote}...${quote} sin cerrar.`);
      out += "''";
      continue;
    }

    if (ch === '[') {
      i += 1;
      let closed = false;
      while (i < sqlText.length) {
        if (sqlText[i] === ']') {
          if (sqlText[i + 1] === ']') {
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) throw new SqlGuardError('Identificador [ ... ] sin cerrar.');
      out += "''";
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/** `read` acepta SELECT y CTE; `explain` acepta además EXPLAIN, SHOW y DESCRIBE. */
export type ReadMode = 'read' | 'explain';

/** Lanza `SqlGuardError` si la sentencia no es una única consulta de lectura. */
export function assertReadOnly(sqlText: string, mode: ReadMode = 'read'): void {
  if (!sqlText || sqlText.trim() === '') {
    throw new SqlGuardError('La consulta está vacía.');
  }

  const code = mask(sqlText);
  const statements = code
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (statements.length === 0) throw new SqlGuardError('La consulta está vacía.');
  if (statements.length > 1) {
    throw new SqlGuardError(
      `Solo se permite una sentencia por llamada y se detectaron ${statements.length}. Divídela en varias llamadas.`,
    );
  }

  const statement = statements[0]!;
  const head = /^(with|select|explain|show|describe|desc|table|values)\b/i.exec(statement);
  const allowed = head !== null && (mode === 'explain' || !/^(explain|show|describe|desc|table|values)\b/i.test(head[0]));
  if (!allowed) {
    throw new SqlGuardError(
      mode === 'explain'
        ? 'Modo solo lectura: la sentencia debe comenzar por SELECT, WITH, EXPLAIN, SHOW o DESCRIBE.'
        : 'Modo solo lectura: la sentencia debe comenzar por SELECT o WITH (CTE).',
    );
  }

  const forbidden = statement.match(FORBIDDEN_KEYWORDS);
  if (forbidden) {
    throw new SqlGuardError(
      `Modo solo lectura: la palabra clave "${forbidden[0].toUpperCase()}" no está permitida. ` +
        'Habilita MSSQL_ALLOW_WRITE=true y usa execute_sql si necesitas modificar datos.',
    );
  }
}
