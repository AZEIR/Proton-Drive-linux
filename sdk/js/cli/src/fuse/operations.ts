/**
 * FUSE Operations for the Proton Drive File-On-Demand daemon.
 *
 * Uses fuse-native (N-API bindings for libfuse on Linux).
 * Each operation receives a callback `cb(errno, ...results)`.
 * errno=0 means success; use negative POSIX errno constants for errors.
 */
import { NodeType, ProtonDriveClient } from '@protontech/drive-sdk';
import {
    closeSync,
    existsSync,
    ftruncateSync,
    mkdirSync,
    openSync,
    readSync,
    statSync,
    utimesSync,
    writeSync,
} from 'node:fs';
import { unlink, rename } from 'node:fs/promises';
import path from 'node:path';

import { CacheManager } from './cache';
import { InodeEntry, InodeTable } from './inode';
import { downloadToCache, Uploader } from './uploader';

// POSIX errno constants (negative in FUSE callbacks)
const ENOENT  = -2;
const EIO     = -5;
const EACCES  = -13;
const EEXIST  = -17;
const ENOTDIR = -20;
const EISDIR  = -21;
const EINVAL  = -22;
const ENOTEMPTY = -39;

// Open file descriptor table entry
interface OpenFd {
    ino:      number;
    nodeUid:  string;
    writable: boolean;
    tmpPath:  string | null;   // set when write was called
    localFd:  number | null;   // OS fd for the cache file
    dirty:    boolean;         // pending upload needed
}

export class FuseOperations {
    /** Map from FUSE file-handle (fh) to our OpenFd descriptor */
    private fds: Map<number, OpenFd> = new Map();
    private nextFh = 1;

    /** Track directories that have already populated their children from remote */
    private populatedDirs: Set<number> = new Set();

    /** Remote root Proton Drive folder UID */
    remoteRootUid: string = '';

    constructor(
        private sdk: ProtonDriveClient,
        private inodes: InodeTable,
        private cache: CacheManager,
        private uploader: Uploader,
        private logger: any,
    ) {}

    // ─── Helpers ─────────────────────────────────────────────────────────────

    private allocFh(): number {
        return this.nextFh++;
    }

    private stat(inode: InodeEntry) {
        const now = Date.now() / 1000;
        const mtime = inode.remote_mtime > 0 ? inode.remote_mtime / 1000 : now;
        return {
            mtime,
            atime: now,
            ctime: mtime,
            nlink: inode.is_dir ? 2 : 1,
            size: inode.size,
            mode: inode.mode,
            uid: process.getuid?.() ?? 1000,
            gid: process.getgid?.() ?? 1000,
        };
    }

    private pathToIno(relativePath: string): InodeEntry | undefined {
        if (relativePath === '/') return this.inodes.getByIno(this.inodes.rootIno);
        const rel = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
        return this.inodes.getByPath(rel);
    }

    /**
     * Populate children of a directory by fetching from the remote SDK,
     * then update inode table. Called lazily on first readdir.
     */
    private async populateChildren(parentIno: number, parentUid: string): Promise<void> {
        const existing = new Set(this.inodes.getChildren(parentIno).map(c => c.node_uid));

        const childrenUids: string[] = [];
        for await (const uid of this.sdk.iterateFolderChildrenNodeUids(parentUid)) {
            if (!existing.has(uid)) {
                childrenUids.push(uid);
            }
        }

        if (childrenUids.length === 0) return;

        const chunkSize = 50;
        for (let i = 0; i < childrenUids.length; i += chunkSize) {
            const chunk = childrenUids.slice(i, i + chunkSize);
            for await (const node of this.sdk.iterateNodes(chunk)) {
                if ('missingUid' in node) continue; // Skip missing nodes
                if (!node || node.trashTime) continue;

                const name = node.name.ok ? node.name.value : `_degraded_${node.uid.slice(0, 8)}`;
                const parentInoEntry = this.inodes.getByIno(parentIno)!;
                const relPath = parentInoEntry.local_path
                    ? `${parentInoEntry.local_path}/${name}`
                    : name;

                if (node.type === NodeType.Folder) {
                    this.inodes.upsert({
                        node_uid:     node.uid,
                        parent_ino:   parentIno,
                        name,
                        local_path:   relPath,
                        is_dir:       1,
                        size:         0,
                        remote_mtime: node.modificationTime.getTime(),
                        is_local:     1,
                        mode:         16877, // 0o40755
                    });
                } else {
                    const revision = node.activeRevision?.ok ? node.activeRevision.value : null;
                    const size = revision?.claimedSize ?? 0;
                    const mtime = revision?.claimedModificationTime
                        ? new Date(revision.claimedModificationTime).getTime()
                        : node.modificationTime.getTime();
                    const isLocal = this.cache.isLocal(node.uid) ? 1 : 0;
                    this.inodes.upsert({
                        node_uid:     node.uid,
                        parent_ino:   parentIno,
                        name,
                        local_path:   relPath,
                        is_dir:       0,
                        size,
                        remote_mtime: mtime,
                        is_local:     isLocal,
                        mode:         33188, // 0o100644
                    });
                }
            }
        }
    }

    // ─── FUSE Operations ─────────────────────────────────────────────────────

    async getattr(p: string, cb: (code: number, stat?: any) => void) {
        const inode = this.pathToIno(p);
        if (!inode) {
            return cb(ENOENT);
        }
        cb(0, this.stat(inode));
    }

    async fgetattr(p: string, fd: number, cb: (code: number, stat?: any) => void) {
        const inode = this.pathToIno(p);
        if (!inode) return cb(ENOENT);
        cb(0, this.stat(inode));
    }

    async readdir(p: string, cb: (code: number, names?: string[]) => void) {
        const inode = this.pathToIno(p);
        if (!inode) return cb(ENOENT);
        if (!inode.is_dir) return cb(ENOTDIR);

        // Populate children lazily from the remote
        if (inode.node_uid && !this.populatedDirs.has(inode.ino)) {
            try {
                await this.populateChildren(inode.ino, inode.node_uid);
                this.populatedDirs.add(inode.ino);
            } catch (err: any) {
                this.logger.error(`[fuse] readdir populate failed for ${p}:`, err);
                // Don't fail — return what we have
            }
        }

        const children = this.inodes.getChildren(inode.ino);
        const names = ['.', '..', ...children.map(c => c.name)];
        cb(0, names);
    }

    async open(p: string, flags: number, cb: (code: number, fh?: number) => void) {
        const inode = this.pathToIno(p);
        if (!inode) return cb(ENOENT);
        if (inode.is_dir) return cb(EISDIR);

        const writable = (flags & 3) !== 0; // O_RDONLY = 0, O_WRONLY = 1, O_RDWR = 2

        // If not cached, download first
        if (!inode.is_local && inode.node_uid) {
            try {
                this.logger.info(`[fuse] On-demand download: ${p}`);
                const node = await this.sdk.getNode(inode.node_uid);
                await downloadToCache(this.sdk, this.cache, this.inodes, node, this.logger);
            } catch (err: any) {
                this.logger.error(`[fuse] Download failed for ${p}:`, err);
                return cb(EIO);
            }
        }

        const localPath = inode.node_uid ? this.cache.localPath(inode.node_uid) : null;
        let localFd: number | null = null;
        let tmpPath: string | null = null;

        if (localPath && existsSync(localPath)) {
            // For writable opens, copy to a temp work file
            if (writable) {
                tmpPath = `${localPath}.write-${Date.now()}`;
                await Bun.write(tmpPath, Bun.file(localPath));
                localFd = openSync(tmpPath, 'r+');
            } else {
                localFd = openSync(localPath, 'r');
            }
        }

        const fh = this.allocFh();
        this.fds.set(fh, {
            ino:      inode.ino,
            nodeUid:  inode.node_uid,
            writable,
            tmpPath,
            localFd,
            dirty:    false,
        });

        cb(0, fh);
    }

    async create(p: string, mode: number, cb: (code: number, fh?: number) => void) {
        // Creating a new file: make a stub inode first
        const rel = p.startsWith('/') ? p.slice(1) : p;
        const name = path.basename(rel);
        const parentRel = path.dirname(rel) === '.' ? '' : path.dirname(rel);
        const parentIno = parentRel
            ? this.inodes.getByPath(parentRel)?.ino ?? this.inodes.rootIno
            : this.inodes.rootIno;

        // Create a temp write file immediately
        const tmpDir = this.cache.cacheDir;
        mkdirSync(tmpDir, { recursive: true });
        const tmpPath = path.join(tmpDir, `new-${Date.now()}-${name}`);
        Bun.write(tmpPath, new Uint8Array(0));

        const ino = this.inodes.upsert({
            node_uid:     '',    // not yet uploaded
            parent_ino:   parentIno,
            name,
            local_path:   rel,
            is_dir:       0,
            size:         0,
            remote_mtime: Date.now(),
            is_local:     0,
            mode,
        });

        const localFd = openSync(tmpPath, 'r+');
        const fh = this.allocFh();
        this.fds.set(fh, {
            ino,
            nodeUid:  '',
            writable: true,
            tmpPath,
            localFd,
            dirty:    true,
        });

        cb(0, fh);
    }

    read(p: string, fd: number, buf: Buffer, len: number, pos: number, cb: (bytesRead: number) => void) {
        const entry = this.fds.get(fd);
        if (!entry || entry.localFd === null) return cb(0);

        try {
            const bytesRead = readSync(entry.localFd, buf, 0, len, pos);
            cb(bytesRead);
        } catch (err: any) {
            this.logger.error(`[fuse] read error at ${p}:`, err);
            cb(0);
        }
    }

    write(p: string, fd: number, buf: Buffer, len: number, pos: number, cb: (bytesWritten: number) => void) {
        const entry = this.fds.get(fd);
        if (!entry || !entry.writable) return cb(0);

        // If no temp file yet (e.g. opened O_WRONLY without create), make one
        if (entry.localFd === null || entry.tmpPath === null) {
            const tmpPath = path.join(this.cache.cacheDir, `write-${Date.now()}`);
            mkdirSync(path.dirname(tmpPath), { recursive: true });
            Bun.write(tmpPath, new Uint8Array(0));
            entry.tmpPath = tmpPath;
            entry.localFd = openSync(tmpPath, 'r+');
        }

        try {
            const written = writeSync(entry.localFd, buf, 0, len, pos);
            entry.dirty = true;
            // Update stub size in inode table
            const inode = this.inodes.getByIno(entry.ino);
            if (inode) {
                const newSize = Math.max(inode.size, pos + written);
                this.inodes.updateSize(entry.ino, newSize);
            }
            cb(written);
        } catch (err: any) {
            this.logger.error(`[fuse] write error at ${p}:`, err);
            cb(0);
        }
    }

    async release(p: string, fd: number, cb: (code: number) => void) {
        const entry = this.fds.get(fd);
        if (!entry) return cb(0);

        if (entry.localFd !== null) {
            try { closeSync(entry.localFd); } catch {}
        }

        if (entry.dirty && entry.tmpPath && existsSync(entry.tmpPath)) {
            const inode = this.inodes.getByIno(entry.ino);
            if (inode) {
                const rel = inode.local_path;
                const name = inode.name;
                const parentIno = this.inodes.getByIno(inode.parent_ino);
                const parentUid = parentIno?.node_uid || this.remoteRootUid;

                // Upload asynchronously — don't block FUSE release
                this.uploader.uploadFile(
                    inode.node_uid || null,
                    parentUid,
                    name,
                    rel,
                    entry.tmpPath,
                ).then((result) => {
                    // Update inode with the real node UID once uploaded
                    this.inodes.upsert({
                        ...inode,
                        node_uid: result.nodeUid,
                        is_local: 1,
                    });
                }).catch((err) => {
                    this.logger.error(`[fuse] Background upload failed for ${rel}:`, err);
                });
            }
        }

        this.fds.delete(fd);
        cb(0);
    }

    async truncate(p: string, size: number, cb: (code: number) => void) {
        const inode = this.pathToIno(p);
        if (!inode) return cb(ENOENT);
        if (inode.is_dir) return cb(EISDIR);

        // If the file is cached locally, truncate it
        if (inode.node_uid && this.cache.isLocal(inode.node_uid)) {
            try {
                ftruncateSync(openSync(this.cache.localPath(inode.node_uid), 'r+'), size);
            } catch {}
        }
        this.inodes.updateSize(inode.ino, size);
        cb(0);
    }

    async mkdir(p: string, mode: number, cb: (code: number) => void) {
        const rel = p.startsWith('/') ? p.slice(1) : p;
        const name = path.basename(rel);
        const parentRel = path.dirname(rel) === '.' ? '' : path.dirname(rel);
        const parentIno = parentRel
            ? this.inodes.getByPath(parentRel)?.ino ?? this.inodes.rootIno
            : this.inodes.rootIno;
        const parentEntry = this.inodes.getByIno(parentIno);
        if (!parentEntry) return cb(ENOENT);

        const parentUid = parentEntry.node_uid || this.remoteRootUid;

        try {
            const node = await this.sdk.createFolder(parentUid, name);
            this.inodes.upsert({
                node_uid:     node.uid,
                parent_ino:   parentIno,
                name,
                local_path:   rel,
                is_dir:       1,
                size:         0,
                remote_mtime: Date.now(),
                is_local:     1,
                mode:         mode | 0o40000,
            });
            cb(0);
        } catch (err: any) {
            if (err.existingNodeUid) {
                return cb(EEXIST);
            }
            this.logger.error(`[fuse] mkdir failed for ${p}:`, err);
            cb(EIO);
        }
    }

    async unlink(p: string, cb: (code: number) => void) {
        const inode = this.pathToIno(p);
        if (!inode) return cb(ENOENT);
        if (inode.is_dir) return cb(EISDIR);

        try {
            if (inode.node_uid) {
                for await (const result of this.sdk.trashNodes([inode.node_uid])) {
                    if (!result.ok) throw result.error;
                }
            }
            await this.cache.evict(inode.node_uid);
            this.inodes.delete(inode.ino);
            cb(0);
        } catch (err: any) {
            this.logger.error(`[fuse] unlink failed for ${p}:`, err);
            cb(EIO);
        }
    }

    async rmdir(p: string, cb: (code: number) => void) {
        const inode = this.pathToIno(p);
        if (!inode) return cb(ENOENT);
        if (!inode.is_dir) return cb(ENOTDIR);

        // Check if empty
        const children = this.inodes.getChildren(inode.ino);
        if (children.length > 0) return cb(ENOTEMPTY);

        try {
            if (inode.node_uid) {
                for await (const result of this.sdk.trashNodes([inode.node_uid])) {
                    if (!result.ok) throw result.error;
                }
            }
            this.inodes.delete(inode.ino);
            cb(0);
        } catch (err: any) {
            this.logger.error(`[fuse] rmdir failed for ${p}:`, err);
            cb(EIO);
        }
    }

    async rename(src: string, dest: string, cb: (code: number) => void) {
        const srcIno = this.pathToIno(src);
        if (!srcIno) return cb(ENOENT);

        const destRel = dest.startsWith('/') ? dest.slice(1) : dest;
        const newName = path.basename(destRel);
        const newParentRel = path.dirname(destRel) === '.' ? '' : path.dirname(destRel);
        const newParentIno = newParentRel
            ? this.inodes.getByPath(newParentRel)?.ino ?? this.inodes.rootIno
            : this.inodes.rootIno;
        const newParentEntry = this.inodes.getByIno(newParentIno);
        if (!newParentEntry) return cb(ENOENT);

        try {
            if (srcIno.node_uid) {
                const isSameDir = srcIno.parent_ino === newParentIno;
                if (isSameDir) {
                    // Rename in place
                    if (srcIno.name !== newName) {
                        await this.sdk.renameNode(srcIno.node_uid, newName);
                    }
                } else {
                    // Move to new parent, then rename if needed
                    const newParentUid = newParentEntry.node_uid || this.remoteRootUid;
                    for await (const result of this.sdk.moveNodes([srcIno.node_uid], newParentUid)) {
                        if (!result.ok) throw result.error;
                    }
                    if (srcIno.name !== newName) {
                        await this.sdk.renameNode(srcIno.node_uid, newName);
                    }
                }
            }

            // Remove old inode and re-insert with new name/path
            this.inodes.delete(srcIno.ino);
            this.inodes.upsert({
                ...srcIno,
                ino:         srcIno.ino,
                name:        newName,
                local_path:  destRel,
                parent_ino:  newParentIno,
            });

            cb(0);
        } catch (err: any) {
            this.logger.error(`[fuse] rename failed ${src} → ${dest}:`, err);
            cb(EIO);
        }
    }


    async utimens(p: string, atime: Date, mtime: Date, cb: (code: number) => void) {
        const inode = this.pathToIno(p);
        if (!inode) return cb(ENOENT);
        this.inodes.updateMtime(inode.ino, mtime.getTime());
        // If cached locally, apply utime
        if (inode.node_uid && this.cache.isLocal(inode.node_uid)) {
            try { utimesSync(this.cache.localPath(inode.node_uid), atime, mtime); } catch {}
        }
        cb(0);
    }

    // Build the fuse-native operations object
    build() {
        return {
            getattr:  (p: string, cb: any) => { void this.getattr(p, cb); },
            fgetattr: (p: string, fd: number, cb: any) => { void this.fgetattr(p, fd, cb); },
            readdir:  (p: string, cb: any) => { void this.readdir(p, cb); },
            open:     (p: string, flags: number, cb: any) => { void this.open(p, flags, cb); },
            create:   (p: string, mode: number, cb: any) => { void this.create(p, mode, cb); },
            read:     (p: string, fd: number, buf: Buffer, len: number, pos: number, cb: any) => {
                this.read(p, fd, buf, len, pos, cb);
            },
            write:    (p: string, fd: number, buf: Buffer, len: number, pos: number, cb: any) => {
                this.write(p, fd, buf, len, pos, cb);
            },
            release:  (p: string, fd: number, cb: any) => { void this.release(p, fd, cb); },
            truncate: (p: string, size: number, cb: any) => { void this.truncate(p, size, cb); },
            mkdir:    (p: string, mode: number, cb: any) => { void this.mkdir(p, mode, cb); },
            unlink:   (p: string, cb: any) => { void this.unlink(p, cb); },
            rmdir:    (p: string, cb: any) => { void this.rmdir(p, cb); },
            rename:   (src: string, dest: string, cb: any) => { void this.rename(src, dest, cb); },
            utimens:  (p: string, atime: Date, mtime: Date, cb: any) => { void this.utimens(p, atime, mtime, cb); },
        };
    }
}
