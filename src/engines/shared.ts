/** Convierte valores de driver y del driver de cada motor a JSON seguro. */
export function toPlain(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  if (Array.isArray(value)) return value.map(toPlain);
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) out[key] = toPlain(source[key]);
    return out;
  }
  return value;
}

/** Filas de un recordset a JSON plano, con la lista de columnas. */
export function rowsToPlain(rows: Array<Record<string, unknown>>, columns?: string[]) {
  const plainRows = rows.map((row) => toPlain(row) as Record<string, unknown>);
  return {
    columns: columns ?? (plainRows[0] ? Object.keys(plainRows[0]) : []),
    rowCount: plainRows.length,
    rows: plainRows,
  };
}

export function suffix(value: string | null | undefined): string {
  return value === null || value === undefined || value.trim() === '' ? '' : ` ${value}`;
}
