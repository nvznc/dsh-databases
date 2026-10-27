import { readFileSync } from 'node:fs';

/** Valida un índice format 1 replicando las reglas de dsh-plugin-market-index. */
const file = process.argv[2];
const doc = JSON.parse(readFileSync(file, 'utf8'));
const errors = [];
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:\d*[a-zA-Z-][0-9a-zA-Z-]*|\d+)(?:\.(?:\d*[a-zA-Z-][0-9a-zA-Z-]*|\d+))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const packageName = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const langId = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/;

const text = (value, path) => {
  if (typeof value === 'string' && value.trim() !== '') return;
  if (value && typeof value === 'object' && 'en' in value) {
    for (const [lang, member] of Object.entries(value)) {
      if (!langId.test(lang)) errors.push(`${path}.${lang}: id de idioma inválido`);
      if (typeof member !== 'string' || member.trim() === '') errors.push(`${path}.${lang}: texto vacío`);
    }
    return;
  }
  errors.push(`${path}: LocalizedText inválido`);
};

if (doc.format !== 1) errors.push('$.format debe ser 1');
text(doc.title, '$.title');
if (doc.description !== undefined) text(doc.description, '$.description');

const categories = new Set(Object.keys(doc.metadata?.categories ?? {}));
const labels = new Set(Object.keys(doc.metadata?.labels ?? {}));
for (const [id, decl] of Object.entries(doc.metadata?.sortKeys ?? {})) {
  if (decl.order !== 'asc' && decl.order !== 'desc') errors.push(`$.metadata.sortKeys.${id}.order`);
}

const names = new Set();
(doc.plugins ?? []).forEach((plugin, index) => {
  const at = `$.plugins[${index}]`;
  if (!packageName.test(plugin.name ?? '') || (plugin.name ?? '').length > 214) errors.push(`${at}.name inválido`);
  if (names.has(plugin.name)) errors.push(`${at}.name duplicado ${plugin.name}`);
  names.add(plugin.name);
  if (plugin.title !== undefined) text(plugin.title, `${at}.title`);
  if (plugin.description !== undefined) text(plugin.description, `${at}.description`);
  if (plugin.metadata?.category && !categories.has(plugin.metadata.category)) errors.push(`${at}.metadata.category no declarada`);
  for (const label of plugin.metadata?.labels ?? []) if (!labels.has(label)) errors.push(`${at}.metadata.labels ${label} no declarada`);
  if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) errors.push(`${at}.versions vacío`);
  const versions = new Set();
  (plugin.versions ?? []).forEach((version, position) => {
    const vAt = `${at}.versions[${position}]`;
    if (!semver.test(version.version ?? '')) errors.push(`${vAt}.version no es SemVer exacta`);
    if (versions.has(version.version)) errors.push(`${vAt}.version duplicada`);
    versions.add(version.version);
    if (!Number.isInteger(version.publishTimestamp) || version.publishTimestamp < 0) errors.push(`${vAt}.publishTimestamp`);
    const source = version.source ?? {};
    if (source.type === 'git') {
      if (!/^https:\/\/[^\s]+$/.test(source.url ?? '')) errors.push(`${vAt}.source.url debe ser https`);
      if (!/^[0-9a-f]{40}$/.test(source.commit ?? '')) errors.push(`${vAt}.source.commit debe ser SHA 40 hex`);
    } else if (source.type !== 'npm') {
      errors.push(`${vAt}.source.type inválido`);
    }
    if (typeof version.engines?.dsh !== 'string' || version.engines.dsh.startsWith('workspace:')) {
      errors.push(`${vAt}.engines.dsh requerido`);
    }
  });
});

if (errors.length) {
  console.error(`✘ ${file}\n` + errors.map((error) => `  - ${error}`).join('\n'));
  process.exit(1);
}
console.log(`✔ ${file}: índice válido (${doc.plugins.length} plugin(s))`);
