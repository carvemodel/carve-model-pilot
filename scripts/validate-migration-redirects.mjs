import fs from 'node:fs/promises';

const config = JSON.parse(await fs.readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
const redirects = config.redirects ?? [];
const migrationRedirects = redirects.filter((rule) => !rule.has);
const errors = [];
const seen = new Set();

for (const rule of migrationRedirects) {
  if (!rule.source?.startsWith('/')) errors.push(`Invalid source: ${rule.source}`);
  if (!rule.destination?.startsWith('/')) {
    errors.push(`Pre-launch destination must remain relative: ${rule.source} -> ${rule.destination}`);
  }
  if (rule.statusCode !== 301) {
    errors.push(`Migration redirect must explicitly return 301: ${rule.source}`);
  }
  if (seen.has(rule.source)) errors.push(`Duplicate redirect source: ${rule.source}`);
  seen.add(rule.source);
}

const requiredSources = [
  '/about',
  '/portfolio-scale-models',
  '/scale-model-faq',
  '/architectural-scale-model-services-carve-model',
  '/model-services',
  '/services',
  '/product-prototype',
  '/film-previsualization',
  '/blog/architectural-scale-model-production-timeline',
  '/blog//architectural-scale-model-cost-us',
  '/blog/category/Cost%20Guide',
  '/blog/category/Architectural%20Scale%20Models',
  '/blog/tag/how%20to%20choose%20model%20scale',
  '/blog/tag/scale%20conversion',
  '/blog/tag/architectural%20modeling',
  '/blog/tag/architecture%20visualization',
];

for (const source of requiredSources) {
  if (!seen.has(source)) errors.push(`Required migration source is missing: ${source}`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`Validated ${migrationRedirects.length} explicit HTTP 301 migration redirects.`);
console.log('Cross-domain forwarding is intentionally absent and remains a migration-day action.');
