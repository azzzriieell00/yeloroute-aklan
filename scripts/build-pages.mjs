import { cp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(root, 'dist');
await mkdir(destination, { recursive: true });
// Publish only the application shell, never development files or credentials.
for (const asset of ['index.html', 'styles.css', 'app.js', 'routing-core.js', 'sw.js', 'icon.svg', 'truck.svg', 'manifest.webmanifest', 'vendor']) {
  await cp(resolve(root, asset), resolve(destination, asset), { recursive: true });
}
await writeFile(resolve(destination, '.nojekyll'), '');
console.log('GitHub Pages files prepared in dist/');
