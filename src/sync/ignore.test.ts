import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { IgnoreMatcher, PROTONIGNORE_FILENAME } from './ignore';

// Helper: create a temporary directory for each test
function makeTempDir(): string {
    const dir = path.join(os.tmpdir(), `proton-ignore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

describe('IgnoreMatcher', () => {
    let tmpDir: string;
    let matcher: IgnoreMatcher;

    beforeEach(() => {
        tmpDir = makeTempDir();
        matcher = new IgnoreMatcher(tmpDir);
    });

    afterEach(() => {
        if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('built-in default patterns', () => {
        it('ignores .DS_Store file', () => {
            expect(matcher.shouldIgnore('.DS_Store', false)).toBe(true);
        });

        it('ignores Thumbs.db file', () => {
            expect(matcher.shouldIgnore('Thumbs.db', false)).toBe(true);
        });

        it('ignores desktop.ini file', () => {
            expect(matcher.shouldIgnore('desktop.ini', false)).toBe(true);
        });

        it('ignores .protonignore itself', () => {
            expect(matcher.shouldIgnore(PROTONIGNORE_FILENAME, false)).toBe(true);
        });

        it('ignores Proton temp download files (*.tmp-*)', () => {
            expect(matcher.shouldIgnore('document.pdf.tmp-1718000000', false)).toBe(true);
        });

        it('ignores Office lock files (~*)', () => {
            expect(matcher.shouldIgnore('~$report.docx', false)).toBe(true);
        });

        it('ignores vim swap files (*.swp, *.swo)', () => {
            expect(matcher.shouldIgnore('file.swp', false)).toBe(true);
            expect(matcher.shouldIgnore('file.swo', false)).toBe(true);
        });

        it('does NOT ignore a regular file', () => {
            expect(matcher.shouldIgnore('report.pdf', false)).toBe(false);
        });

        it('does NOT ignore a regular folder', () => {
            expect(matcher.shouldIgnore('documents', true)).toBe(false);
        });

        it('does NOT ignore .git directory (syncs like any other folder)', () => {
            expect(matcher.shouldIgnore('.git', true)).toBe(false);
        });

        it('does NOT ignore node_modules directory', () => {
            expect(matcher.shouldIgnore('node_modules', true)).toBe(false);
        });

        it('does NOT ignore .vscode directory', () => {
            expect(matcher.shouldIgnore('.vscode', true)).toBe(false);
        });

        it('does NOT ignore .idea directory', () => {
            expect(matcher.shouldIgnore('.idea', true)).toBe(false);
        });

        it('does NOT ignore .obsidian directory', () => {
            expect(matcher.shouldIgnore('.obsidian', true)).toBe(false);
        });

        it('does NOT ignore files inside .git', () => {
            expect(matcher.shouldIgnore('.git/config', false)).toBe(false);
        });
    });

    describe('.protonignore user patterns', () => {
        it('respects custom glob pattern from .protonignore', () => {
            writeFileSync(path.join(tmpDir, PROTONIGNORE_FILENAME), '*.log\n');
            matcher.reload();
            expect(matcher.shouldIgnore('server.log', false)).toBe(true);
            expect(matcher.shouldIgnore('server.txt', false)).toBe(false);
        });

        it('respects exact name match', () => {
            writeFileSync(path.join(tmpDir, PROTONIGNORE_FILENAME), 'dist\n');
            matcher.reload();
            expect(matcher.shouldIgnore('dist', true)).toBe(true);
            expect(matcher.shouldIgnore('packages/app/dist', true)).toBe(true);
        });

        it('can ignore node_modules via user pattern', () => {
            writeFileSync(path.join(tmpDir, PROTONIGNORE_FILENAME), 'node_modules/\n');
            matcher.reload();
            expect(matcher.shouldIgnore('node_modules', true)).toBe(true);
            expect(matcher.shouldIgnore('node_modules', false)).toBe(false); // file named "node_modules" not ignored
            expect(matcher.shouldIgnore('packages/app/node_modules', true)).toBe(true);
        });

        it('can ignore .git via user pattern', () => {
            writeFileSync(path.join(tmpDir, PROTONIGNORE_FILENAME), '.git/\n');
            matcher.reload();
            expect(matcher.shouldIgnore('.git', true)).toBe(true);
            expect(matcher.shouldIgnore('.git/config', false)).toBe(true);
        });

        it('ignores comment lines (#)', () => {
            writeFileSync(path.join(tmpDir, PROTONIGNORE_FILENAME), '# This is a comment\n*.log\n');
            matcher.reload();
            expect(matcher.shouldIgnore('server.log', false)).toBe(true);
        });

        it('ignores blank lines', () => {
            writeFileSync(path.join(tmpDir, PROTONIGNORE_FILENAME), '\n\n*.tmp\n\n');
            matcher.reload();
            expect(matcher.shouldIgnore('file.tmp', false)).toBe(true);
        });

        it('supports directory-only patterns (trailing /)', () => {
            writeFileSync(path.join(tmpDir, PROTONIGNORE_FILENAME), 'build/\n');
            matcher.reload();
            expect(matcher.shouldIgnore('build', true)).toBe(true);
            expect(matcher.shouldIgnore('build', false)).toBe(false); // file named "build" not ignored
        });

        it('handles missing .protonignore gracefully', () => {
            // No file created — should not throw
            expect(() => matcher.reload()).not.toThrow();
            expect(matcher.shouldIgnore('report.pdf', false)).toBe(false);
        });

        it('supports rooted patterns (leading /)', () => {
            writeFileSync(path.join(tmpDir, PROTONIGNORE_FILENAME), '/cache\n');
            matcher.reload();
            // Rooted: matches only at top level
            expect(matcher.shouldIgnore('cache', true)).toBe(true);
        });
    });

    describe('negation patterns (!)', () => {
        it('un-ignores a user-blocked directory via !pattern', () => {
            writeFileSync(path.join(tmpDir, PROTONIGNORE_FILENAME), '.git/\n!.git/\n');
            matcher.reload();
            expect(matcher.shouldIgnore('.git', true)).toBe(false);
        });

        it('un-ignores a custom pattern added earlier in the same file', () => {
            writeFileSync(path.join(tmpDir, PROTONIGNORE_FILENAME), '*.log\n!important.log\n');
            matcher.reload();
            expect(matcher.shouldIgnore('server.log', false)).toBe(true);
            expect(matcher.shouldIgnore('important.log', false)).toBe(false);
        });

        it('still ignores paths that do not match the negation', () => {
            writeFileSync(path.join(tmpDir, PROTONIGNORE_FILENAME), '.git/\n.svn/\n!.git/\n');
            matcher.reload();
            // .git is un-ignored; .svn is still blocked
            expect(matcher.shouldIgnore('.git', true)).toBe(false);
            expect(matcher.shouldIgnore('.svn', true)).toBe(true);
        });

        it('ignores a bare ! line (empty after stripping)', () => {
            writeFileSync(path.join(tmpDir, PROTONIGNORE_FILENAME), '!\n*.log\n');
            matcher.reload();
            // bare ! is discarded; *.log should still be applied
            expect(matcher.shouldIgnore('server.log', false)).toBe(true);
        });
    });

    describe('reload()', () => {
        it('picks up new rules after reload', () => {
            expect(matcher.shouldIgnore('output.log', false)).toBe(false);
            writeFileSync(path.join(tmpDir, PROTONIGNORE_FILENAME), '*.log\n');
            matcher.reload();
            expect(matcher.shouldIgnore('output.log', false)).toBe(true);
        });

        it('removes rules after .protonignore is cleared and reloaded', () => {
            writeFileSync(path.join(tmpDir, PROTONIGNORE_FILENAME), '*.log\n');
            matcher.reload();
            expect(matcher.shouldIgnore('output.log', false)).toBe(true);

            // Clear the file
            writeFileSync(path.join(tmpDir, PROTONIGNORE_FILENAME), '');
            matcher.reload();
            // Default patterns still apply but *.log is no longer custom-ignored
            expect(matcher.shouldIgnore('output.log', false)).toBe(false);
        });
    });
});
