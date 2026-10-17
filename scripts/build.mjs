import { cp, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(root, 'dist');
const entries = ['index.html', 'css', 'img', 'js'];

// Publish only game assets. Product documents, Git metadata and local files stay private.
if (path.dirname(output) !== root || path.basename(output) !== 'dist') {
  throw new Error('Refusing to rebuild a directory outside the project dist folder.');
}
for (const entry of entries) {
  const source = path.join(root, entry);
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Cannot publish a symbolic link: ${entry}`);
}
await rm(output, { recursive: true, force: true });
await mkdir(output);
for (const entry of entries) {
  await cp(path.join(root, entry), path.join(output, entry), { recursive: true });
}

// Files have stable names, so browsers should revalidate before using a cached release.
await writeFile(path.join(output, '_headers'), [
  '/*',
  '  Cache-Control: public, max-age=0, must-revalidate',
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  '',
].join('\n'));

const html = await readFile(path.join(output, 'index.html'), 'utf8');
const references = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(match => match[1]);
for (const reference of references) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference)) continue;
  const asset = path.resolve(output, reference.split(/[?#]/)[0]);
  const relative = path.relative(output, asset);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Asset reference leaves deployment directory: ${reference}`);
  }
  await stat(asset);
}

let count = 0;
let bytes = 0;
async function inspect(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error(`Symbolic link in deployment: ${absolute}`);
    if (item.isDirectory()) { await inspect(absolute); continue; }
    if (item.name.endsWith('.md') || item.name.startsWith('.')) {
      throw new Error(`Private or unexpected file in deployment: ${absolute}`);
    }
    const info = await stat(absolute);
    if (info.size > 25 * 1024 * 1024) {
      throw new Error(`Asset exceeds Cloudflare Pages file size limit: ${absolute}`);
    }
    count++;
    bytes += info.size;
  }
}
await inspect(output);
console.log(JSON.stringify({ output: 'dist', files: count, bytes, htmlReferencesChecked: references.length }));

