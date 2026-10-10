import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const template = await readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');
const registrationSource = await readFile(new URL('../src/serviceWorkerRegistration.ts', import.meta.url), 'utf8');
const scope = 'https://example.test/FossFLOW/';
const manifest = ['./index.html', './static/js/index.abc123.js', './manifest.json'];
const flush = () => new Promise(resolve => setImmediate(resolve));

function worker({ cacheNames = [], offline = false } = {}) {
  const listeners = {};
  const deleted = [];
  const cached = [];
  const opened = [];
  const fetched = [];
  const cache = {
    addAll: async requests => cached.push(...requests.map(request => request.url)),
    match: async url => new Response(`cached:${url}`),
  };
  const context = {
    URL, Request, Response, Set,
    self: { registration: { scope }, addEventListener: (name, handler) => { listeners[name] = handler; } },
    caches: {
      open: async name => { opened.push(name); return cache; },
      keys: async () => cacheNames,
      delete: async name => { deleted.push(name); return true; },
    },
    fetch: async request => {
      fetched.push(request.url);
      if (offline) throw new Error('offline');
      return new Response('online');
    },
  };
  vm.runInNewContext(template
    .replace('/* precache-manifest */ []', JSON.stringify(manifest))
    .replace("/* precache-version */ 'unbuilt'", "'current'"), context);
  return { listeners, deleted, cached, opened, fetched };
}

function registration(prefix = '/FossFLOW/', ancestorScope = scope) {
  const calls = [];
  const unregistered = [];
  const listeners = {};
  const exports = {};
  const context = {
    exports, URL, console,
    process: { env: { ASSET_PREFIX: prefix } },
    document: { readyState: 'loading' },
    window: {
      location: { href: `${scope}index.html`, origin: 'https://example.test' },
      addEventListener: (name, handler) => { listeners[name] = handler; },
    },
    navigator: { serviceWorker: {
      register: async (url, options) => { calls.push({ url, options }); return {}; },
      getRegistration: async () => ({ scope: ancestorScope, unregister: async () => unregistered.push(ancestorScope) }),
    } },
  };
  vm.runInNewContext(ts.transpileModule(registrationSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return { exports, calls, unregistered, listeners, context };
}

test('Pages registration uses the app prefix and exact scope, including a missing trailing slash', async () => {
  for (const prefix of ['/FossFLOW/', '/FossFLOW']) {
    const app = registration(prefix);
    app.exports.register();
    assert.equal(app.calls.length, 0);
    app.listeners.load();
    await flush();
    assert.equal(app.calls[0].url, `${scope}service-worker.js`);
    assert.equal(app.calls[0].options.scope, scope);
    assert.equal(app.calls[0].options.updateViaCache, 'none');
  }
});

test('root deployment and registration after load work; cross-origin assets do not register', async () => {
  const root = registration('/');
  root.context.document.readyState = 'complete';
  root.exports.register();
  await flush();
  assert.equal(root.calls[0].url, 'https://example.test/service-worker.js');
  const cdn = registration('https://cdn.test/FossFLOW/');
  cdn.exports.register();
  assert.equal(cdn.listeners.load, undefined);
});

test('development unregister leaves another app\'s ancestor worker intact', async () => {
  const ancestor = registration('/FossFLOW/', 'https://example.test/');
  ancestor.exports.unregister();
  await flush();
  assert.deepEqual(ancestor.unregistered, []);
  const own = registration();
  own.exports.unregister();
  await flush();
  assert.deepEqual(own.unregistered, [scope]);
});

test('install precaches current hashed files under this app only', async () => {
  const app = worker();
  let pending;
  app.listeners.install({ waitUntil: promise => { pending = promise; } });
  await pending;
  assert.deepEqual(app.cached, manifest.map(path => new URL(path, scope).href));
  assert.ok(app.opened.every(name => name === `fossflow:${scope}:current`));
});

test('activation deletes only obsolete caches belonging to this exact scope', async () => {
  const names = ['another-app-v1', 'fossflow-v1', 'fossflow:https://example.test/Other/:old',
    `fossflow:${scope}:old`, `fossflow:${scope}:current`];
  const app = worker({ cacheNames: names });
  let pending;
  app.listeners.activate({ waitUntil: promise => { pending = promise; } });
  await pending;
  assert.deepEqual(app.deleted, [`fossflow:${scope}:old`]);
});

test('fetch bypasses non-GET, cross-origin, neighboring apps, APIs and unknown assets', () => {
  const app = worker();
  for (const request of [
    { url: `${scope}index.html`, method: 'POST' },
    { url: 'https://cdn.test/FossFLOW/index.html', method: 'GET' },
    { url: 'https://example.test/codeflow/index.html', method: 'GET' },
    { url: 'https://example.test/FossFLOW-other/index.html', method: 'GET' },
    { url: `${scope}api/diagrams`, method: 'GET' },
    { url: `${scope}unknown.json`, method: 'GET' },
  ]) {
    let intercepted = false;
    app.listeners.fetch({ request, respondWith: () => { intercepted = true; } });
    assert.equal(intercepted, false, request.url);
  }
});

test('navigation is current online and falls back to the precached shell offline', async () => {
  for (const offline of [false, true]) {
    const app = worker({ offline });
    let response;
    app.listeners.fetch({ request: { url: scope, method: 'GET', mode: 'navigate' },
      respondWith: promise => { response = promise; } });
    assert.equal(await (await response).text(), offline ? `cached:${scope}index.html` : 'online');
  }
});

test('hashed static assets work offline without fetching or caching user data', async () => {
  const app = worker({ offline: true });
  let response;
  app.listeners.fetch({ request: { url: `${scope}static/js/index.abc123.js`, method: 'GET', mode: 'cors' },
    respondWith: promise => { response = promise; } });
  assert.match(await (await response).text(), /cached:.*index\.abc123\.js/);
  assert.deepEqual(app.fetched, []);
});

test('build generator discovers actual hashed assets and changes version when content changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fossflow-worker-test-'));
  try {
    await mkdir(join(directory, 'scripts'));
    await mkdir(join(directory, 'public'));
    await mkdir(join(directory, 'build/static/js'), { recursive: true });
    const script = await readFile(new URL('../scripts/generate-service-worker.mjs', import.meta.url));
    await writeFile(join(directory, 'scripts/generate-service-worker.mjs'), script);
    await writeFile(join(directory, 'public/service-worker.js'), template);
    await writeFile(join(directory, 'build/index.html'), '<script src="static/js/index.abc.js"></script>');
    await writeFile(join(directory, 'build/static/js/index.abc.js'), 'first');
    await writeFile(join(directory, 'build/static/js/index.abc.js.map'), '{}');
    const generate = () => execFileSync(process.execPath, [join(directory, 'scripts/generate-service-worker.mjs')]);
    generate();
    const first = await readFile(join(directory, 'build/service-worker.js'), 'utf8');
    assert.match(first, /\.\/static\/js\/index\.abc\.js/);
    assert.doesNotMatch(first, /\.js\.map/);
    assert.doesNotMatch(first, /precache-manifest|unbuilt';/);
    await writeFile(join(directory, 'build/static/js/index.abc.js'), 'second');
    generate();
    const second = await readFile(join(directory, 'build/service-worker.js'), 'utf8');
    assert.notEqual(first.match(/const VERSION = (.*);/)[1], second.match(/const VERSION = (.*);/)[1]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('install manifest stays in the project path', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.json', import.meta.url)));
  const manifestUrl = `${scope}manifest.json`;
  assert.equal(new URL(manifest.scope, manifestUrl).href, scope);
  assert.equal(new URL(manifest.start_url, manifestUrl).href, scope);
});
