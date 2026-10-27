#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from './config.js';
import { ConnectionRegistry } from './engines/registry.js';
import { log, setLogLevel } from './logger.js';
import { registerTools } from './tools.js';

const VERSION = '2.0.0';

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const registry = new ConnectionRegistry(config);
  const server = new McpServer(
    { name: 'mcp-databases', version: VERSION, title: 'Bases de datos SQL' },
    {
      capabilities: { tools: {} },
      instructions:
        'Servidor MCP para SQL Server, MySQL/MariaDB y PostgreSQL. Empieza con list_connections para ver qué ' +
        'conexiones existen y su motor; elige una con el parámetro "connection". Explora con list_databases, ' +
        'list_tables y describe_table antes de ejecutar run_query (solo lectura, filas acotadas por maxRows). ' +
        'Nunca inventes credenciales: si falta una conexión, pide los datos al usuario y guárdala con save_connection.',
    },
  );

  registerTools(server, registry, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const connections = registry.summarize();
  log.info(
    `Listo por stdio. Motor por defecto: ${config.engine}. Conexiones: ` +
      `${connections.map((entry) => `${entry.name}(${entry.engine})`).join(', ') || 'ninguna'}. ` +
      `Modo ${config.allowWrite ? 'lectura/escritura' : 'solo lectura'}.`,
  );

  // Comprobación de conectividad en segundo plano: el protocolo ya está disponible
  // y un fallo se reporta en cada tool call con un mensaje claro.
  void (async () => {
    try {
      const adapter = registry.create(registry.resolve(process.env.DSH_MCP_SQL_CONNECTION));
      await adapter.ping();
      await adapter.close();
      log.info('Conexión por defecto verificada.');
    } catch (error) {
      log.warn(`No se pudo verificar la conexión por defecto: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Cerrando por ${signal}…`);
    void server.close().catch(() => undefined).finally(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (error) => {
    log.error('Excepción no capturada; cerrando', error);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('Promesa rechazada sin manejar', reason);
  });
}

main().catch((error: unknown) => {
  log.error('No se pudo iniciar el servidor MCP', error);
  process.exit(1);
});
