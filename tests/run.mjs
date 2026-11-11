// Runs the static checks and every e2e test file, each in its own process, and prints a summary.
// Usage: node run.mjs [name-filter]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] || '';
const files = [
  path.join(here, 'static', 'service-worker.check.mjs'),
  ...fs.readdirSync(path.join(here, 'e2e')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join(here, 'e2e', f)),
].filter((f) => path.basename(f).includes(filter));

const summary = [];
for (const file of files) {
  const name = path.relative(here, file);
  console.log(`\n=== ${name}`);
  const started = Date.now();
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit', timeout: 240_000 });
  const ok = r.status === 0;
  summary.push({ name, ok, sec: ((Date.now() - started) / 1000).toFixed(1), note: r.error ? r.error.message : '' });
}
console.log('\n=== Summary');
for (const s of summary) console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.name} (${s.sec}s)${s.note ? ` ${s.note}` : ''}`);
const failed = summary.filter((s) => !s.ok).length;
console.log(failed ? `\n${failed} of ${summary.length} failed` : `\nall ${summary.length} passed`);
process.exit(failed ? 1 : 0);
