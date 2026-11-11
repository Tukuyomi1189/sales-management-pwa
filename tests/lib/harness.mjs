// Shared test harness: a static server for the app (with js/firebase-init.js swapped for a
// Firestore look-alike), a Chromium launcher, and pass/fail checks.
//
// Every e2e test file runs on its own (`node e2e/xxx.test.mjs`) and exits non-zero on failure,
// so tests/run.mjs can run them one by one and report which one broke.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, inspect } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
// The app under test: this repository, or APP_ROOT (e.g. an older copy, to see a test fail there).
export const APP_ROOT = process.env.APP_ROOT ? path.resolve(process.env.APP_ROOT) : path.resolve(here, '..', '..');
export const OUT_DIR = path.resolve(here, '..', 'out'); // screenshots / downloads (git-ignored)
fs.mkdirSync(OUT_DIR, { recursive: true });

const MOCK = fs.readFileSync(path.join(here, 'mock-firebase-init.js'));
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.pdf': 'application/pdf',
};

/**
 * Serve the app from APP_ROOT. js/firebase-init.js is replaced by the mock, and
 * service-worker.js is not served unless `serviceWorker: true` (most tests want a plain page).
 */
export function startServer({ serviceWorker = false } = {}) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    if (p === '/js/firebase-init.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(MOCK);
    }
    const file = path.join(APP_ROOT, p);
    if ((!serviceWorker && p === '/service-worker.js') || !file.startsWith(APP_ROOT)
        || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }).listen(0);
  const base = `http://localhost:${server.address().port}`;
  return { base, close: () => server.close() };
}

/** Chromium: CHROMIUM_PATH if set, else a preinstalled /opt/pw-browsers/chromium, else Playwright's own. */
export function launchBrowser() {
  const candidates = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium'].filter(Boolean);
  const executablePath = candidates.find((p) => fs.existsSync(p));
  return chromium.launch(executablePath ? { executablePath } : {});
}

export const IPAD = { viewport: { width: 1194, height: 834 }, hasTouch: true, isMobile: true };
export const IPAD_DESKTOP = { viewport: { width: 1180, height: 820 }, hasTouch: true };
export const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

/** Collects page errors (and console errors not matching `ignore`) for one page. */
export function watchErrors(t, page, tag = 'page', { ignore = /service-?worker|404/i } = {}) {
  page.on('pageerror', (e) => t.errors.push(`${tag}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !ignore.test(m.text())) t.errors.push(`${tag}: console: ${m.text()}`);
  });
}

/** Pass/fail bookkeeping for one test file. */
export function createTest(name) {
  const results = [];
  const t = {
    errors: [],
    /** Deep-equal check. */
    eq(label, got, want) {
      results.push({ label, ok: isDeepStrictEqual(got, want), got, want });
    },
    /** Truthy check; `detail` is printed on failure. */
    ok(label, cond, detail) {
      results.push({ label, ok: !!cond, got: detail, want: 'truthy' });
    },
    /** Regex check on a string. */
    match(label, got, re) {
      results.push({ label, ok: typeof got === 'string' && re.test(got), got, want: String(re) });
    },
    /** Print the report and exit (non-zero if anything failed or a page error happened). */
    finish() {
      const failed = results.filter((r) => !r.ok);
      for (const r of results) {
        console.log(`${r.ok ? '  ok  ' : '  NG  '} ${r.label}`);
        if (!r.ok) {
          console.log(`         got:  ${inspect(r.got, { depth: 4, breakLength: 120 })}`);
          console.log(`         want: ${inspect(r.want, { depth: 4, breakLength: 120 })}`);
        }
      }
      for (const e of t.errors) console.log(`  NG   page error: ${e}`);
      const pass = failed.length === 0 && t.errors.length === 0 && results.length > 0;
      console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${results.length - failed.length}/${results.length} checks${t.errors.length ? `, ${t.errors.length} page errors` : ''}`);
      process.exitCode = pass ? 0 : 1;
      return pass;
    },
  };
  return t;
}

/** Run `body(t)`; an exception (e.g. a timeout) fails the file instead of hanging it. */
export async function runTest(name, body) {
  const t = createTest(name);
  try {
    await body(t);
  } catch (err) {
    t.errors.push(`exception: ${err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err}`);
  }
  t.finish();
  // Playwright/server handles may keep the loop alive after a failure: exit explicitly.
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref?.();
}
