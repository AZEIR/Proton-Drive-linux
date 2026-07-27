#!/usr/bin/env bun

import path from 'node:path';
import { chmodSync, mkdirSync } from 'node:fs';

const projectRoot = path.resolve(import.meta.dir, '..');
const releaseDir = path.join(projectRoot, 'release');
mkdirSync(releaseDir, { recursive: true });

const result = await Bun.build({
    entrypoints: [path.join(projectRoot, 'src/cli/daemon.ts')],
    target: 'node',
    format: 'esm',
    external: ['better-sqlite3', 'fuse-native', 'undici'],
    plugins: [
        {
            name: 'node-sqlite-compatibility',
            setup(build) {
                build.onResolve({ filter: /^bun:sqlite$/ }, () => ({
                    path: path.join(projectRoot, 'src/sync/sqlite.ts'),
                }));
            },
        },
    ],
});

if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
}
if (result.outputs.length !== 1) {
    throw new Error(`Expected one daemon bundle, received ${result.outputs.length}`);
}
await Bun.write(path.join(releaseDir, 'proton-sync.js'), result.outputs[0]);

const launcher = `#!/bin/bash
set -e
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
    echo "Node.js is required to run Proton Drive Linux." >&2
    exit 1
fi
exec "$NODE_BIN" "$(dirname "$0")/proton-sync.js" "$@"
`;
await Bun.write(path.join(releaseDir, 'proton-sync'), launcher);
chmodSync(path.join(releaseDir, 'proton-sync'), 0o755);
