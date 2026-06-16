import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Built-in patterns that are always ignored regardless of user config.
 * Entries ending with '/' are directory-only patterns.
 */
const DEFAULT_PATTERNS: string[] = [
    'node_modules/',
    '.git/',
    '.svn/',
    '.hg/',
    '.idea/',
    '.vscode/',
    '.DS_Store',
    'Thumbs.db',
    'desktop.ini',
    '*.tmp-*',      // Proton sync temp files
    '~*',           // Office/LibreOffice lock files
    '*.swp',        // Vim swap files
    '*.swo',
    '.protonignore', // Never sync the ignore file itself
];

/** Name of the user-editable ignore file, placed in the sync root. */
export const PROTONIGNORE_FILENAME = '.protonignore';

interface CompiledPattern {
    regex: RegExp;
    dirOnly: boolean;
}

/**
 * Lightweight ignore matcher for the Proton Drive sync engine.
 *
 * Supports:
 *   - Exact names:          `.DS_Store`
 *   - Wildcard globs:       `*.log`, `~*`
 *   - Directory-only:       `node_modules/`  (trailing slash)
 *   - Rooted patterns:      `/cache/` only matches at the root level
 *   - Blank lines and `#` comments in .protonignore
 */
export class IgnoreMatcher {
    private compiled: CompiledPattern[] = [];
    private syncRoot: string;

    constructor(syncRoot: string) {
        this.syncRoot = syncRoot;
        this.reload();
    }

    /**
     * Re-reads .protonignore from the sync root (if present) and rebuilds matchers.
     * Safe to call at any time — replaces the compiled rule set atomically.
     */
    reload(): void {
        const userPatterns = this.loadUserPatterns();
        this.compiled = [...DEFAULT_PATTERNS, ...userPatterns].map(compilePattern).filter((p): p is CompiledPattern => p !== null);
    }

    /**
     * Returns true if this path should be excluded from sync and watching.
     *
     * @param relativePath  Path relative to the sync root, using forward slashes.
     * @param isDir         Whether the path refers to a directory.
     */
    shouldIgnore(relativePath: string, isDir: boolean): boolean {
        // Normalise to forward slashes for consistent matching
        const normalized = relativePath.replace(/\\/g, '/');
        const basename = path.posix.basename(normalized);

        for (const { regex, dirOnly } of this.compiled) {
            // Directory-only patterns skip files
            if (dirOnly && !isDir) continue;

            // Test against both the full relative path and the basename
            if (regex.test(normalized) || regex.test(basename)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Returns the absolute path to the .protonignore file for this sync root.
     */
    get ignorePath(): string {
        return path.join(this.syncRoot, PROTONIGNORE_FILENAME);
    }

    private loadUserPatterns(): string[] {
        try {
            if (!existsSync(this.ignorePath)) return [];
            const content = readFileSync(this.ignorePath, 'utf8');
            return content
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(line => line.length > 0 && !line.startsWith('#'));
        } catch {
            return [];
        }
    }
}

/**
 * Compiles a single ignore pattern string into a regex.
 * Returns null if the pattern is empty after normalisation.
 *
 * Strategy: replace glob wildcards with safe placeholders first, then
 * regex-escape the rest, then restore placeholders as regex equivalents.
 * This avoids the ordering problem of trying to un-escape after a blanket escape.
 */
function compilePattern(raw: string): CompiledPattern | null {
    let pattern = raw.trim();
    if (!pattern || pattern.startsWith('#')) return null;

    // Trailing slash marks a directory-only pattern
    const dirOnly = pattern.endsWith('/');
    if (dirOnly) pattern = pattern.slice(0, -1);

    // Leading slash marks a rooted (top-level-only) pattern
    const rooted = pattern.startsWith('/');
    if (rooted) pattern = pattern.slice(1);

    // Step 1: swap glob chars for unique placeholders that won't appear in filenames
    const STAR_PH  = '\x00STAR\x00';
    const QMARK_PH = '\x00QMARK\x00';
    let regexStr = pattern
        .replace(/\*/g, STAR_PH)
        .replace(/\?/g, QMARK_PH);

    // Step 2: escape all remaining regex special characters
    regexStr = regexStr.replace(/[.+^${}()|[\]\\]/g, '\\$&');

    // Step 3: restore wildcards as their regex equivalents
    regexStr = regexStr
        .replace(new RegExp(STAR_PH, 'g'), '[^/]*')  // * matches anything except /
        .replace(new RegExp(QMARK_PH, 'g'), '[^/]');  // ? matches a single non-slash char

    // Rooted patterns match only at path start; others match basename anywhere
    if (rooted) {
        regexStr = '^' + regexStr + '(/.*)?$';
    } else {
        regexStr = '(^|/)' + regexStr + '(/.*)?$';
    }

    try {
        return { regex: new RegExp(regexStr), dirOnly };
    } catch {
        return null;
    }
}
