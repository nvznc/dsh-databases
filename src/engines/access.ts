/**
 * Filtro compartido: aplica `MSSQL_ALLOWED_DATABASES` sobre la conexión pedida.
 * La lista blanca es opcional; vacía significa "todas las accesibles".
 */
export function assertAllowsDatabase(allowed: string[], database: string | undefined): void {
  if (allowed.length === 0) return;
  if (!database) {
    throw new Error(
      `Configura "database": la lista MSSQL_ALLOWED_DATABASES exige elegir una de ${allowed.join(', ')}.`,
    );
  }
  if (!allowed.some((name) => name.toLowerCase() === database.toLowerCase())) {
    throw new Error(`La base "${database}" no está permitida por MSSQL_ALLOWED_DATABASES (${allowed.join(', ')}).`);
  }
}
