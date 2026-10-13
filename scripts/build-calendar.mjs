import { build } from 'esbuild';
import { copyFile, readFile, writeFile } from 'node:fs/promises';

await build({
    entryPoints: ['charts/meeting-calendar.mjs'],
    outfile: 'assets/meeting-calendar.min.mjs',
    bundle: true,
    minify: true,
    format: 'esm',
    target: ['es2020'],
    legalComments: 'eof',
    logLevel: 'info'
});
// Normalize license-comment whitespace without changing bundled code or strings.
const bundlePath = 'assets/meeting-calendar.min.mjs';
const bundle = await readFile(bundlePath, 'utf8');
const licenseStart = bundle.lastIndexOf('\n/*! Bundled license information:');
if (licenseStart !== -1) {
    await writeFile(bundlePath, bundle.slice(0, licenseStart) + bundle.slice(licenseStart).replace(/[\t ]+$/gm, ''));
}
await copyFile('node_modules/echarts/LICENSE', 'assets/echarts-LICENSE.txt');
await copyFile('node_modules/echarts/NOTICE', 'assets/echarts-NOTICE.txt');
await copyFile('node_modules/zrender/LICENSE', 'assets/zrender-LICENSE.txt');
