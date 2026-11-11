// Static checks on service-worker.js (no browser):
//  1. every app file the page loads is in PRECACHE_URLS (else it is missing offline), and
//     every precached local file exists (else the service worker fails to install);
//  2. the Firebase SDK version matches js/firebase-init.js;
//  3. when app files changed compared with BASE_REF (a pull request's target branch),
//     CACHE_VERSION changed too — otherwise devices keep running the old version.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP_ROOT, createTest } from '../lib/harness.mjs';

const t = createTest('service-worker');
const read = (f) => fs.readFileSync(path.join(APP_ROOT, f), 'utf8');
const sw = read('service-worker.js');

const listMatch = sw.match(/const PRECACHE_URLS = \[([\s\S]*?)\];/);
t.ok('PRECACHE_URLS found', listMatch);
const precache = listMatch ? [...listMatch[1].matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]) : [];

// 1a. everything index.html loads (scripts, stylesheets, manifest, icons) is precached
const html = read('index.html');
const referenced = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1].replace(/^\.\//, ''))
  .filter((u) => !u.startsWith('http') && !u.startsWith('docs/') && /\.(js|css|json|png|svg|webmanifest)$/.test(u));
const appFiles = [
  ...fs.readdirSync(path.join(APP_ROOT, 'js')).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`),
  ...fs.readdirSync(path.join(APP_ROOT, 'css')).filter((f) => f.endsWith('.css')).map((f) => `css/${f}`),
  ...fs.readdirSync(path.join(APP_ROOT, 'icons')).filter((f) => f.endsWith('.png')).map((f) => `icons/${f}`),
];
const missing = [...new Set([...referenced, ...appFiles, 'index.html', 'manifest.json'])].filter((f) => !precache.includes(f));
t.eq('every app file is in PRECACHE_URLS', missing, []);

// 1b. every precached local file exists
const notFound = precache.filter((f) => f && !fs.existsSync(path.join(APP_ROOT, f)));
t.eq('every precached file exists', notFound, []);

// 2. Firebase SDK version in sync
const swSdk = (sw.match(/FIREBASE_SDK_VERSION = '([^']+)'/) || [])[1];
const initSdk = (read('js/firebase-init.js').match(/SDK_VERSION = '([^']+)'/) || [])[1];
t.ok('SDK versions found', swSdk && initSdk, { swSdk, initSdk });
t.eq('Firebase SDK version matches js/firebase-init.js', swSdk, initSdk);

// 3. CACHE_VERSION bumped when app files changed (only when BASE_REF is given, e.g. in CI)
const version = (sw.match(/const CACHE_VERSION = '([^']+)'/) || [])[1];
t.ok('CACHE_VERSION found', version);
const baseRef = process.env.BASE_REF;
if (baseRef) {
  const git = (...args) => execFileSync('git', args, { cwd: APP_ROOT, encoding: 'utf8' });
  const ref = git('rev-parse', '--verify', '--quiet', `origin/${baseRef}`).trim() ? `origin/${baseRef}` : baseRef;
  const mergeBase = git('merge-base', ref, 'HEAD').trim();
  const changed = git('diff', '--name-only', mergeBase, 'HEAD').split('\n').filter(Boolean);
  const isAppFile = (f) => f === 'index.html' || f === 'manifest.json' || /^(js|css|icons)\//.test(f);
  const changedApp = changed.filter(isAppFile);
  const baseVersion = (git('show', `${mergeBase}:service-worker.js`).match(/const CACHE_VERSION = '([^']+)'/) || [])[1];
  console.log(`  (base ${ref}: CACHE_VERSION ${baseVersion} → ${version}; app files changed: ${changedApp.length})`);
  t.ok(
    'CACHE_VERSION bumped when app files changed',
    changedApp.length === 0 || version !== baseVersion,
    { changedApp, baseVersion, version },
  );
} else {
  console.log('  (BASE_REF not set: skipping the CACHE_VERSION bump check)');
}

t.finish();
