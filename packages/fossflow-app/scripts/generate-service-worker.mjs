import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const buildRoot = join(appRoot, 'build');
const template = await readFile(join(appRoot, 'public/service-worker.js'), 'utf8');

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.filter(entry => !entry.name.startsWith('.'))
    .map(entry => entry.isDirectory()
      ? filesIn(join(directory, entry.name))
      : [join(directory, entry.name)]));
  return files.flat();
}

const files = (await filesIn(buildRoot))
  .filter(file => !file.endsWith('.map') && relative(buildRoot, file) !== 'service-worker.js')
  .sort();
const digest = createHash('sha256').update(template);
const manifest = [];
for (const file of files) {
  const path = relative(buildRoot, file).split('\\').join('/');
  manifest.push(`./${path}`);
  digest.update(path).update(await readFile(file));
}
if (!manifest.includes('./index.html')) throw new Error('Missing built index.html');

const worker = template
  .replace('/* precache-manifest */ []', JSON.stringify(manifest))
  .replace("/* precache-version */ 'unbuilt'", JSON.stringify(digest.digest('hex').slice(0, 16)));
await writeFile(join(buildRoot, 'service-worker.js'), worker);
console.log(`Generated scoped service worker for ${manifest.length} build files`);
