import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
const license = await readFile('node_modules/marked/LICENSE', 'utf8');
const result = await build({ entryPoints: ['src/markdown.ts'], outfile: 'public/markdown.js', write: false, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, banner: { js: '/* Bundled marked 18.1.0 license:\n' + license.replaceAll('*/', '* /') + '\n*/' } });
const output = result.outputFiles[0].text;
if (process.argv.includes('--check')) {
 if (await readFile('public/markdown.js', 'utf8') !== output) throw new Error('Markdown bundle is stale; run npm run build:ui');
} else await writeFile('public/markdown.js', output);
