# dsh-databases — MCP de bases de datos para DSH

Servidor [Model Context Protocol](https://modelcontextprotocol.io) para **DeepSeek Harness** que
expone **SQL Server, MySQL/MariaDB y PostgreSQL** al agente. Permite elegir con qué conexión trabajar
(por nombre) y qué motor usar, explorar bases, tablas y columnas, y ejecutar consultas devolviendo JSON
acotado.

- **Transporte:** stdio (lo lanza DSH como subproceso).
- **Drivers:** [`mssql`](https://www.npmjs.com/package/mssql), [`mysql2`](https://www.npmjs.com/package/mysql2)
  y [`pg`](https://www.npmjs.com/package/pg) — JavaScript puro, sin ODBC ni DLLs.
- **Múltiples conexiones con nombre**, con motor propio cada una.
- **Modo:** lectura + escritura opcional (`MSSQL_ALLOW_WRITE`); `run_query` siempre es de solo lectura.

## Tres formas de elegir base de datos y motor

| Forma | Para qué sirve | Dónde |
|---|---|---|
| `.env` | Conexión única rápida ("default") | variables `MSSQL_*` |
| `configs/connections.json` | Lista fija de conexiones por nombre y motor | archivo JSON versionable (sin secretos) |
| `save_connection` (herramienta MCP) | El agente guarda conexiones nuevas en caliente | `~/.dsh-mcp-sql/connections.json` |

Además, cualquier herramienta acepta `connection` (nombre) y `engine`
(`mssql` \| `mysql` \| `postgres`) en la misma llamada.

## Herramientas MCP

Con `serverName: db` DSH las expone como `mcp__db__<nombre>`:

| Herramienta | Qué hace |
|---|---|
| `list_connections` | Motores disponibles y conexiones configuradas (sin contraseñas). |
| `save_connection` | Crea o reemplaza una conexión con nombre (motor, host, puerto, base, usuario, contraseña, opciones). |
| `remove_connection` | Elimina una conexión guardada con `save_connection`. |
| `test_connection` | Conecta y devuelve versión/host/usuario reales, o el error exacto. |
| `list_databases` | Bases accesibles con estado y tamaño. |
| `list_tables` | Tablas y/o vistas con filas aproximadas. |
| `describe_table` | Columnas, tipos, índices y claves foráneas. |
| `run_query` | Una sentencia de lectura (`SELECT`/`WITH`; en mysql/postgres también `EXPLAIN`, `SHOW`, `DESCRIBE`). |
| `server_info` | Versión, host, usuario y arranque del servidor. |
| `execute_sql` | Escritura/DDL, solo con `MSSQL_ALLOW_WRITE=true`. |

## Instalación

```powershell
npm install
npm run build
Copy-Item .env.example .env        # credenciales
Copy-Item configs/connections.example.json configs/connections.json
```

## Configuración (`.env`)

| Variable | Por defecto | Descripción |
|---|---|---|
| `MSSQL_ENGINE` | `mssql` | Motor de la conexión por defecto: `mssql` \| `mysql` \| `postgres`. |
| `MSSQL_SERVER` / `MSSQL_PORT` | `localhost` / `1433` | Host y puerto. |
| `MSSQL_DATABASE` | `master` | Base por defecto. |
| `MSSQL_USER` / `MSSQL_PASSWORD` | — | Credenciales de la conexión por defecto. |
| `MSSQL_ENCRYPT` / `MSSQL_TRUST_SERVER_CERTIFICATE` | `true` / `true` | TLS para SQL Server. |
| `MSSQL_ALLOW_WRITE` | `false` | Habilita `execute_sql`. |
| `MSSQL_ALLOWED_DATABASES` | vacío | Lista blanca de bases separada por comas. |
| `MSSQL_MAX_ROWS` | `200` | Filas por consulta (tope 5000). |
| `MSSQL_QUERY_TIMEOUT_MS` / `MSSQL_CONNECT_TIMEOUT_MS` | `30000` / `15000` | Timeouts. |
| `MSSQL_CONFIGS` | `configs/connections.json` | Archivo de conexiones declaradas. |
| `DSH_MCP_SQL_CONNECTION` | — | Conexión usada cuando la herramienta no indica ninguna. |
| `DSH_MCP_SQL_HOME` | `~/.dsh-mcp-sql` | Dónde se guardan las conexiones creadas con `save_connection`. |
| `MSSQL_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` (logs por **stderr**). |

### Conexiones declaradas (`configs/connections.json`)

```json
{
  "connections": [
    {
      "name": "farmaluz",
      "engine": "mssql",
      "host": "localhost",
      "port": 1433,
      "database": "FarmaluzAdminDb",
      "user": "mcp_sql",
      "password": "tu-clave",
      "options": { "encrypt": true, "trustServerCertificate": true }
    },
    {
      "name": "core-mysql",
      "engine": "mysql",
      "host": "10.0.0.5",
      "port": 3306,
      "database": "erp",
      "user": "consulta",
      "password": "tu-clave",
      "options": { "ssl": false }
    }
  ]
}
```

`configs/connections.json` está en `.gitignore` (contiene contraseñas); versiona
`connections.example.json` como plantilla. Alternativa sin secretos en el repo: dejar `password`
vacío aquí y guardarlo con `save_connection`, que escribe en `~/.dsh-mcp-sql/connections.json`.

### Ejemplos de uso desde el agente

```text
list_connections
test_connection            {"connection": "farmaluz"}
list_tables                {"connection": "core-mysql", "kind": "tables"}
describe_table             {"connection": "core-mysql", "table": "facturas"}
run_query                  {"connection": "farmaluz", "sql": "SELECT TOP 10 * FROM SAPROD"}
save_connection            {"name": "pg-test", "engine": "postgres", "host": "localhost",
                            "database": "postgres", "user": "postgres", "password": "..."}
```

## Registro en DSH

### Como plugin instalado (recomendado)

El paquete declara `dsh.bundle.patch` (`cordis.patch.yml`), así que DSH lo gestiona como bundle:
aparece en **Plugins** del sidebar y se puede instalar desde el índice del market.

### Como fila del perfil (sin empaquetar)

En `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`, sustituyendo `<RUTA>` por la carpeta
donde clonaste este repo:

```yaml
- insert:
    - id: mcp-databases
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: db
        transport: stdio
        command: 'node'
        args:
          - '<RUTA>/dist/index.js'
        cwd: '<RUTA>'
        toolCallTimeoutMs: 120000
```

> **Importante:** la entrada va dentro de un `insert:`. El loader de DSH solo aplica parches
> *por id existente*; una entrada nueva suelta se descarta con
> `patch: entry "mcp-databases" not found`.

### Instalar desde el market

**Plugins → Discover → Add index source** con la URL del índice publicado
(`https://nvznc.github.io/dsh-databases/index.json`), busca *Databases* e instala. DSH clona el
repositorio en el `commit` listado y monta el bundle; tras instalar, define las credenciales (`.env`
o `save_connection`) y reinicia para que el servidor MCP arranque.

## Índice del plugin market (GitHub)

El índice sigue el formato 1 de DSH (`@deepseek-ai/dsh-plugin-market-index`): JSON válido, versiones
fijadas a un `commit` de Git en `https://`, y `engines.dsh`.

```powershell
npm run index -- --repo https://github.com/nvznc/dsh-databases --commit <sha40> --version 1.0.0
npm run index:check          # valida el índice contra las reglas del formato
git add site && git commit -m "market: index" && git push
```

Cada vez que publiques una versión nueva: cambia `version` en `package.json`, compila, súbelo, y
regenera el índice con el **nuevo** `commit` (`git rev-parse HEAD`).

Publicación en **GitHub Pages** (Settings → Pages → Deploy from a branch → `main` / `/site`).
Una vez publicada, en DSH: **Plugins → Discover → Add index source** con
`https://nvznc.github.io/dsh-databases/index.json`.

## Seguridad

- `run_query` pasa por una guarda de solo lectura (`src/guard.ts`): enmascara comentarios, literales y
  identificadores citados, exige **una sola** sentencia, empieza por `SELECT`/`WITH` (`EXPLAIN`/`SHOW`
  solo en mysql/postgres) y rechaza palabras clave de escritura, `COPY`, `pg_sleep`, `xp_cmdshell`…
- Los permisos reales los decide el motor: usa logins de solo lectura (`sql/create-mcp-login.sql` crea
  uno para SQL Server).
- Las contraseñas nunca se imprimen en los logs ni en `list_connections`; `configs/connections.json`
  está ignorado por git.
- `execute_sql` solo existe con `MSSQL_ALLOW_WRITE=true`.

## Scripts

```powershell
npm run build        # compila TypeScript a dist/
npm start            # arranca el servidor (normalmente lo lanza DSH)
npm run verify       # comprobaciones reales contra cada conexión (incluye rollback de escritura)
npm run smoke -- farmaluz "SELECT 1 AS ok"
npm run index        # genera site/index.json para el plugin market
npm run index:check  # valida el índice
```

## Solución de problemas

| Síntoma | Causa / solución |
|---|---|
| `Login failed for user …` | Credenciales desincronizadas; revisa `.env` o `configs/connections.json` y prueba `test_connection`. |
| `No se pudo abrir la conexión TCP` | Puerto/TCP del motor: `MSSQL_PORT` o `port` de la conexión (1433/3306/5432). |
| `Faltan credenciales para la conexión …` | Completa `user`/`password` en `.env` o guarda la conexión con `save_connection`. |
| Las tools no aparecen en DSH | Usa `insert:` en `cordis.patch.yml` y que `dist/index.js` exista (`npm run build`). |
| Las conexiones nuevas no aparecen | Editar `connections.json` requiere reiniciar el servidor MCP; `save_connection` aplica al instante. |

## Estructura

```
src/
  config.ts        # .env, rutas de datos y validación de variables
  guard.ts         # guarda de solo lectura (cualquier motor)
  tools.ts         # definición de herramientas MCP
  index.ts         # arranque stdio y apagado ordenado
  engines/
    types.ts       # contratos EngineAdapter / ConnectionProfile
    registry.ts    # resolución de conexiones y guardado
    mssql.ts       # SQL Server (pool por base)
    mysql.ts       # MySQL / MariaDB
    postgres.ts    # PostgreSQL
scripts/           # smoke, verify, generador y validador del índice
sql/               # creación/borrado del login de solo lectura en SQL Server
site/              # índice publicable del plugin market (GitHub Pages)
```
