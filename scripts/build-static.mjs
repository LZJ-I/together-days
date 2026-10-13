import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const output = new URL('public/', root);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

// Publish only browser files; Vercel builds API functions separately.
for (const entry of ['index.html', 'config.js', 'sites.json', 'assets', 'admin', 'data']) {
    await cp(new URL(entry, root), new URL(entry, output), { recursive: true });
}

console.log(`Static site built: ${fileURLToPath(output)}`);
