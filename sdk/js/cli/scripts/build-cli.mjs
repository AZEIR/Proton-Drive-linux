#!/usr/bin/env bun

import path from 'node:path';
import { execFileSync } from 'node:child_process';

const GIT_ROOT = path.resolve(import.meta.dir, '../../..');

const mode = process.argv[2] || 'main';

const target = process.argv[3] || 'bun';
let outfileArchitecture = '';
if (target.startsWith('bun-')) {
    outfileArchitecture   = '/' + target.slice(4);
}

let entry = 'src/proton-drive.ts';
let outfile = `release${outfileArchitecture}/proton-drive`;

if (mode === 'internal') {
    entry = 'src/internal-cli/proton-drive-internal.ts';
    outfile = `release${outfileArchitecture}/proton-drive-internal`;
} else if (mode === 'sync') {
    entry = 'src/proton-sync.ts';
    outfile = `release${outfileArchitecture}/proton-sync`;
} else if (mode === 'fuse') {
    // File-On-Demand FUSE daemon (default FOD mode)
    entry = 'src/proton-sync.ts';
    outfile = `release${outfileArchitecture}/proton-fuse`;
}

const isFuse = mode === 'fuse';

const args = [
    'build',
];

if (!isFuse) {
    args.push('--compile', `--target=${target}`, '--bytecode');
} else {
    args.push('--target=node', '--external', 'better-sqlite3', '--external', 'fuse-native');
}

args.push(
    '--format=esm',
    '--minify',
    '--sourcemap=inline',
    '--define',
    `APP_VERSION=${JSON.stringify(`${process.env.CLI_APP_VERSION_NAME || 'external-drive-sdkclijs'}@${getVersion('cli') || '0.0.0'}`)}`,
    '--define',
    `SDK_VERSION=${JSON.stringify(`js@${getVersion('js')}`)}`,
    '--define',
    `SENTRY_DSN=${JSON.stringify(process.env.SENTRY_DSN)}`,
    entry,
    `--outfile=${outfile}`,
);

const proc = Bun.spawn(['bun', ...args], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env, NODE_ENV: 'production' },
});
const code = await proc.exited;
if (code !== 0) {
    process.exit(code);
}

if (isFuse) {
    const fs = await import('node:fs/promises');
    const content = await fs.readFile(outfile, 'utf8');
    if (!content.startsWith('#!/usr/bin/env node')) {
        await fs.writeFile(outfile, '#!/usr/bin/env node\n' + content, 'utf8');
    }
    await fs.chmod(outfile, 0o755);
    console.log(`✓ shebang added and permissions updated for ${outfile}`);
}

/**
 * Returns version from environment variable if set,
 * otherwise from local git repository.
 * Returns undefined if no version can be determined.
 */
function getVersion(tagPrefix) {
    const envName = { cli: 'CLI_VERSION', js: 'JS_VERSION' }[tagPrefix];
    const envVersion = envName ? process.env[envName]?.trim() : undefined;
    if (envVersion) {
        return envVersion;
    }
    try {
        const shortHash = getShortHash();
        const semver = semverFromLatestTag(tagPrefix);
        return `${semver}+${shortHash}`;
    } catch (error) {
        console.warn(`Error getting version for ${tagPrefix}:`, error);
        return undefined;
    }
}

/**
 * Returns latest version (as x.y.z) from tags matching
 * `{tagPrefix}/vx.y.z`, or `0.0.0` if none.
 */
function semverFromLatestTag(tagPrefix) {
    const tags = git(['tag', '-l', `${tagPrefix}/v*`, '--sort=-v:refname']);
    const tag = tags.split('\n').find(Boolean);
    if (!tag) {
        console.warn(`No tag found for ${tagPrefix}`);
        return '0.0.0';
    }
    const prefixSlashV = `${tagPrefix}/v`;
    if (!tag.startsWith(prefixSlashV)) {
        console.warn(`No tag found for ${tagPrefix}`);
        return '0.0.0';
    }
    return tag.slice(prefixSlashV.length);
}

function getShortHash() {
    return git(['rev-parse', '--short', 'HEAD']);
}

function git(args) {
    return execFileSync('git', args, {
        encoding: 'utf8',
        cwd: GIT_ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
}
