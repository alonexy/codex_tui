import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const output = 'public/vendor';
await mkdir(output, { recursive: true });
const result = await build({
  entryPoints: ['scripts/mermaid-runtime.js'], bundle: true, minify: true,
  format: 'iife', target: ['es2020'], outfile: `${output}/mermaid-renderer.js`,
  metafile: true, legalComments: 'eof',
});
// Keep upstream notices for all packages whose code enters the browser bundle.
const packages = new Set();
for (const file of Object.keys(result.metafile.inputs)) {
  const match = file.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)/);
  if (match) packages.add(match[1]);
}
const notices = [];
for (const path of [...packages].sort()) {
  const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
  const names = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'LICENSE-MIT'];
  let license;
  for (const name of names) {
    try { license = await readFile(join(path, name), 'utf8'); break; } catch { /* Check alternate upstream names. */ }
  }
  if (!license) {
    try { license = (await readFile(join(path, 'README.md'), 'utf8')).match(/## License\s+([\s\S]+)$/i)?.[1]; } catch { /* License may be embedded in upstream README. */ }
  }
  if (!license) throw Error(`Missing license for ${pkg.name}; inspect ${dirname(path)}`);
  notices.push(`## ${pkg.name}@${pkg.version} (${pkg.license})\n\n${license.trim()}\n`);
}
await writeFile(`${output}/mermaid-LICENSES.txt`, notices.join('\n'));
console.log(`Bundled Mermaid and ${packages.size - 1} dependencies with local license notices.`);
