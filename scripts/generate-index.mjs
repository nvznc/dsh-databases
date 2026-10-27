/**
 * Genera un índice de plugin market (format 1) para DSH.
 * El formato lo define @deepseek-ai/dsh-plugin-market-index; aquí se replican
 * sus reglas para no depender de paquetes internos de la instalación.
 *
 * Uso:  node scripts/generate-index.mjs
 *       node scripts/generate-index.mjs --repo nvznc/dsh-databases --commit <sha> --path . --version 1.0.0
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const repoUrl = arg('repo', 'https://github.com/nvznc/dsh-databases');
const commit = arg('commit') ?? gitCommit();
const dir = arg('path', '.');
const version = arg('version', '1.0.0');
const dshRange = arg('engines-dsh', '>=0.2.0-rc.3');
const publishTimestamp = Number(arg('timestamp', Math.floor(Date.now() / 1000)));

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    throw new Error('No hay commit de Git: pasa --commit <sha40> o ejecuta dentro del repositorio.');
  }
}

if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('--commit debe ser un SHA de 40 hex en minúsculas.');

const index = {
  format: 1,
  title: { en: 'DSH Databases', es: 'Bases de datos DSH' },
  description: {
    en: 'MCP server for SQL Server, MySQL/MariaDB and PostgreSQL with named connections',
    es: 'Servidor MCP para SQL Server, MySQL/MariaDB y PostgreSQL con conexiones con nombre',
  },
  metadata: {
    categories: {
      data: { title: { en: 'Data', es: 'Datos' } },
      database: { title: { en: 'Databases', es: 'Bases de datos' } },
    },
    labels: {
      mcp: { title: { en: 'MCP', es: 'MCP' } },
      local: { title: { en: 'Local', es: 'Local' } },
    },
    sortKeys: {
      version: { title: { en: 'Release', es: 'Versión' }, order: 'desc' },
    },
  },
  plugins: [
    {
      name: 'dsh-databases',
      title: { en: 'Databases (MCP)', es: 'Bases de datos (MCP)' },
      description: {
        en: 'Explore and query SQL Server, MySQL and PostgreSQL from DSH with named connections, read-only guard and optional writes.',
        es: 'Explora y consulta SQL Server, MySQL y PostgreSQL desde DSH con conexiones con nombre, guarda de solo lectura y escritura opcional.',
      },
      author: 'nvznc',
      homepage: `${repoUrl}#readme`,
      repository: { url: repoUrl, ...(dir !== '.' ? { directory: dir } : {}) },
      metadata: {
        category: 'database',
        labels: ['mcp'],
        keywords: ['sql', 'sqlserver', 'mysql', 'postgres', 'database', 'mcp'],
        sortKeys: { version: 1 },
      },
      versions: [
        {
          version,
          publishTimestamp,
          source: { type: 'git', url: repoUrl, commit, ...(dir !== '.' ? { path: dir } : {}) },
          engines: { dsh: dshRange },
        },
      ],
    },
  ],
};

const outDir = resolve(root, 'site');
const outFile = resolve(outDir, 'index.json');
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
console.log(`Escrito ${outFile}`);
console.log(`commit ${commit} · versión ${version} · engines.dsh ${dshRange}`);
