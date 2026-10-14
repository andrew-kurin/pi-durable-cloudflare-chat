import {readFile,writeFile,readdir} from 'node:fs/promises';
const names=(await readdir('vendor/lucide')).filter(n=>n.endsWith('.svg')).sort();
const symbols=await Promise.all(names.map(async file=>{const svg=await readFile('vendor/lucide/'+file,'utf8');return '<symbol id="icon-'+file.slice(0,-4)+'" viewBox="0 0 24 24">'+svg.replace(/^[\s\S]*?<svg[^>]*>/,'').replace(/<\/svg>\s*$/,'').trim()+'</symbol>';}));
const sprite='<!-- LUCIDE START --><!-- Lucide 1.57.0; Copyright (c) 2026 Lucide Icons and Contributors; Feather Copyright (c) 2013-present Cole Bemis. Full notices: /lucide-license.txt --><svg class="icon-sprite" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><defs>'+symbols.join('')+'</defs></svg><!-- LUCIDE END -->';
const html=await readFile('public/index.html','utf8');const next=html.includes('<!-- LUCIDE START -->')?html.replace(/<!-- LUCIDE START -->[\s\S]*?<!-- LUCIDE END -->/,sprite):html.replace('<body>','<body>'+sprite);
if(process.argv.includes('--check')){if(next!==html)throw Error('Lucide sprite is stale; run npm run build:ui');}else await writeFile('public/index.html',next);

const license=await readFile('vendor/lucide/LICENSE','utf8');if(process.argv.includes('--check')){if(await readFile('public/lucide-license.txt','utf8')!==license)throw Error('Lucide license copy is stale');}else await writeFile('public/lucide-license.txt',license);
