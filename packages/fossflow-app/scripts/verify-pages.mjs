import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const base = new URL(process.env.BASE_URL);
if (!base.pathname.endsWith('/')) base.pathname += '/';
const buildRoot = process.env.BUILD_ROOT || 'build';
const output = 'qa-results';
await mkdir(output, { recursive: true });
const report = { head: process.env.DEPLOYED_HEAD, url: base.href, checks: [], pageErrors: [] };
const hash = value => createHash('sha256').update(value).digest('hex');
const worker = await readFile(join(buildRoot, 'service-worker.js'), 'utf8');
const files = JSON.parse(worker.match(/const PRECACHE_FILES = (.*);/)[1]);
const currentVersion = JSON.parse(worker.match(/const VERSION = (.*);/)[1]);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let browser;

try {
  // Pages edges may briefly serve the previous deployment. Require this exact
  // worker and HTML before browser QA, rather than treating a stale site as success.
  for (const file of ['service-worker.js', 'index.html', ...files.map(path => path.slice(2)).filter(path => path !== 'index.html')]) {
    const expected = hash(await readFile(join(buildRoot, file)));
    let actual;
    let status;
    for (let attempt = 0; attempt < 24; attempt++) {
      const response = await fetch(new URL(file, base), { cache: 'no-store' });
      status = response.status;
      actual = hash(Buffer.from(await response.arrayBuffer()));
      if (response.ok && expected === actual) break;
      await delay(5000);
    }
    assert.equal(status, 200, `${file} live HTTP status`);
    assert.equal(actual, expected, `${file} must match deployed artifact`);
  }
  report.checks.push(`All ${files.length + 1} live files match the exact Pages artifact`);

  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ locale: 'en-US', acceptDownloads: true,
    viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(String(error)));
  page.on('dialog', dialog => dialog.accept());
  // A same-origin fixture lets us seed neighboring app data before installation.
  const fixture = new URL('maintenance-cache-fixture', base).href;
  await page.route(fixture, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Cache fixture</title>' }));
  await page.goto(fixture);
  await page.evaluate(async scope => {
    await caches.open('maintenance-other-app');
    await caches.open(`fossflow:${new URL('../AnotherApp/', scope).href}:old`);
    await caches.open(`fossflow:${scope}:maintenance-old`);
    localStorage.setItem('maintenance-other-app-data', 'preserve-me');
  }, base.href);
  await page.unroute(fixture);
  await page.goto(base.href, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Save (Session Only)', exact: true }).waitFor();
  const registration = await page.evaluate(async () => {
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Worker did not activate within 30 seconds')), 30000)),
    ]);
    return { scope: registration.scope, script: registration.active.scriptURL, caches: await caches.keys() };
  });
  assert.equal(registration.scope, base.href);
  assert.equal(registration.script, new URL('service-worker.js', base).href);
  assert.ok(registration.caches.includes(`fossflow:${base.href}:${currentVersion}`));
  assert.ok(!registration.caches.includes(`fossflow:${base.href}:maintenance-old`));
  assert.ok(registration.caches.includes('maintenance-other-app'));
  assert.ok(registration.caches.includes(`fossflow:${new URL('../AnotherApp/', base).href}:old`));
  assert.equal(await page.evaluate(() => localStorage.getItem('maintenance-other-app-data')), 'preserve-me');
  report.registration = registration;
  report.checks.push('Live worker installs at the project scope and preserves unrelated caches/data');

  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL), registration.script);
  await page.getByRole('button', { name: 'Save (Session Only)', exact: true }).click();
  await page.getByPlaceholder('Enter diagram name').fill('Pages Verification');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Current: Pages Verification', { exact: false }).waitFor();
  await page.getByRole('button', { name: /Export File/ }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON', exact: true }).click();
  const download = await downloadPromise;
  const exportPath = join(output, 'export.json');
  await download.saveAs(exportPath);
  const exported = JSON.parse(await readFile(exportPath, 'utf8'));
  assert.ok(exported.title && Array.isArray(exported.items) && Array.isArray(exported.views));
  report.checks.push('Live editor saves a diagram and exports parseable JSON');
  await page.screenshot({ path: join(output, 'live-online.png'), fullPage: true });

  await context.setOffline(true);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Save (Session Only)', exact: true }).waitFor();
  await page.getByText('Current: Pages Verification', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Load (Session Only)', exact: true }).click();
  await page.locator('.diagram-item').filter({ hasText: 'Pages Verification' }).getByRole('button', { name: 'Load', exact: true }).click();
  await page.getByText('Current: Pages Verification', { exact: false }).waitFor();
  await page.screenshot({ path: join(output, 'live-offline.png'), fullPage: true });
  assert.deepEqual(report.pageErrors, []);
  report.checks.push('Live deployment renders editor and reloads saved diagram offline');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error);
  throw error;
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser?.close();
}
