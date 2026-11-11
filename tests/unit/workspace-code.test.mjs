// js/firebase-init.js の共有コードまわり(e2e では Firebase ごと差し替えるので、ここで直接確認):
// 新しいコードは安全な乱数で8文字・読み間違えやすい文字なし、参加時は8文字以上の英数字だけ受け付け、
// 小文字・空白・ハイフンは正規化、すでに端末にあるコードはそのまま使える。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { APP_ROOT, createTest } from '../lib/harness.mjs';

const t = createTest('workspace-code');
const source = fs.readFileSync(path.join(APP_ROOT, 'js/firebase-init.js'), 'utf8');

/** Load firebase-init.js in a sandbox (the SDK import fails there, which the file already tolerates). */
function load(stored = {}) {
  const store = new Map(Object.entries(stored));
  let randomCalls = 0;
  const sandbox = {
    window: {},
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    crypto: { getRandomValues: (a) => { randomCalls++; return webcrypto.getRandomValues(a); } },
    Math: Object.create(Math, { random: { value: () => { throw new Error('Math.random must not be used for codes'); } } }),
    console: { error() {}, warn() {}, log() {} },
  };
  vm.runInNewContext(source, sandbox);
  return { Cloud: sandbox.window.Cloud, store, randomCalls: () => randomCalls };
}

const KEY = 'sales-management-workspace-id';
{
  const { Cloud, store, randomCalls } = load();
  const codes = new Set();
  const first = Cloud.getWorkspaceId();
  t.match('new code: 8 letters from the readable alphabet', first, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  t.eq('new code is saved on the device', store.get(KEY), first);
  t.eq('the same code is returned next time', Cloud.getWorkspaceId(), first);
  t.ok('crypto.getRandomValues is used', randomCalls() >= 1, randomCalls());
  for (let i = 0; i < 200; i++) { store.delete(KEY); codes.add(Cloud.getWorkspaceId()); }
  t.ok('codes do not repeat (200 generated)', codes.size === 200, codes.size);
}
{
  const { Cloud, store } = load({ [KEY]: 'TEST' });
  t.eq('an existing short code keeps working', Cloud.getWorkspaceId(), 'TEST');
  const refused = (raw) => { try { Cloud.setWorkspaceId(raw); return ''; } catch (e) { return e.message; } };
  t.match('joining a short code is refused', refused('ABC123'), /8文字以上/);
  t.match('symbols are refused', refused('ABCD!EFGH'), /英字と数字だけ/);
  t.match('empty is refused', refused('   '), /入力してください/);
  t.eq('a refused join leaves the current code', store.get(KEY), 'TEST');
  t.eq('lower case, spaces and hyphens are normalized', Cloud.setWorkspaceId(' abcd-efgh '), 'ABCDEFGH');
  t.eq('the joined code is saved', store.get(KEY), 'ABCDEFGH');
  t.eq('workspaceIdProblem is empty for a good code', Cloud.workspaceIdProblem('k7m2 p9qa'), '');
}
t.finish();
