import {
    closeSync,
    constants,
    existsSync,
    fsyncSync,
    ftruncateSync,
    mkdirSync,
    openSync,
    readSync,
    statSync,
    truncateSync,
    unlinkSync,
    writeSync,
} from 'node:fs';
import { copyFile, unlink as unlinkFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import Fuse from 'fuse-native';
import { SyncDatabase } from '../sync/db';
import { FodHydrator } from './hydrator';
import { getSha1 } from '../sdk/adapter';
import { openFileReadableStream } from '../utils/fileStreams';

interface OpenHandle {
    relPath: string;
    nodeUid: string;
    cachePath: string;
    localFd: number;
    isDirty: boolean;
    flags: number;
}

export interface FuseDriverOptions {
    clientUid?: string;
    uploadDebounceMs?: number;
    uploadRetryBaseMs?: number;
    uploadRetryMaxMs?: number;
}

export class FuseDriver extends EventEmitter {
    private fuse: any = null;
    private isMounted: boolean = false;
    private activeUploads: Map<string, any> = new Map();
    private uploadPromises: Map<string, Promise<void>> = new Map();
    private dirtyUploads: Set<string> = new Set();
    private uploadTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private uploadGenerations: Map<string, number> = new Map();
    private nextFd: number = 100;
    private openHandles: Map<number, OpenHandle> = new Map();
    private isPaused = false;

    constructor(
        private mountPoint: string,
        private db: SyncDatabase,
        private hydrator: FodHydrator,
        private sdk: any,
        private logger: any,
        private options: FuseDriverOptions = {},
    ) {
        super();
    }

    getActiveUploads(): any[] {
        return Array.from(this.activeUploads.values());
    }

    setPaused(paused: boolean): void {
        this.isPaused = paused;
        if (!paused && this.isMounted) this.resumePendingUploads();
    }

    /**
     * Older versions only logged failed FUSE uploads. Recover any such cached
     * writes into the durable queue before the metadata scan can replace their
     * local modification metadata.
     */
    recoverFailedUploads(): number {
        let recovered = 0;
        for (const relPath of this.db.getUnresolvedFailedUploadPaths()) {
            if (this.db.hasPendingFodUpload(relPath)) continue;
            const mapping = this.db.getMapping(relPath);
            if (!mapping || mapping.is_dir === 1) continue;
            const cachePath = this.hydrator.getCachePath(mapping.node_uid);
            if (!existsSync(cachePath)) continue;
            this.db.setPendingFodUpload(relPath, mapping.node_uid, cachePath);
            recovered++;
        }
        if (recovered > 0) {
            this.logger.info(`Recovered ${recovered} failed FUSE upload(s) into the durable writeback queue.`);
            this.resumePendingUploads();
        }
        return recovered;
    }

    async mount(): Promise<void> {
        if (this.isMounted) return;
        mkdirSync(this.mountPoint, { recursive: true });

        const self = this;
        const ops = {
            getattr(filePath: string, cb: (code: number, stat?: any) => void) {
                if (filePath === '/') {
                    return cb(0, {
                        mtime: new Date(),
                        atime: new Date(),
                        ctime: new Date(),
                        nlink: 2,
                        size: 4096,
                        mode: 16877, // S_IFDIR | 0755
                        uid: process.getuid ? process.getuid() : 1000,
                        gid: process.getgid ? process.getgid() : 1000,
                    });
                }

                const relPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
                const mapping = self.db.getMapping(relPath);

                if (mapping) {
                    const isDir = mapping.is_dir === 1;
                    const mtimeDate = mapping.mtime ? new Date(mapping.mtime) : new Date();
                    let fileSize = isDir ? 4096 : mapping.size;
                    if (!isDir && mapping.node_uid) {
                        const cachePath = self.hydrator.getCachePath(mapping.node_uid);
                        if (existsSync(cachePath)) {
                            try {
                                fileSize = statSync(cachePath).size;
                            } catch {}
                        }
                    }
                    return cb(0, {
                        mtime: mtimeDate,
                        atime: mtimeDate,
                        ctime: mtimeDate,
                        nlink: isDir ? 2 : 1,
                        size: fileSize,
                        mode: isDir ? 16877 : 33188, // 0755 vs 0644
                        uid: process.getuid ? process.getuid() : 1000,
                        gid: process.getgid ? process.getgid() : 1000,
                    });
                }

                // Check if any mappings start with relPath + '/' (virtual folder check)
                const hasChildren = self.db.hasMappingsByPrefix(relPath);

                if (hasChildren) {
                    const mtimeDate = new Date();
                    return cb(0, {
                        mtime: mtimeDate,
                        atime: mtimeDate,
                        ctime: mtimeDate,
                        nlink: 2,
                        size: 4096,
                        mode: 16877,
                        uid: process.getuid ? process.getuid() : 1000,
                        gid: process.getgid ? process.getgid() : 1000,
                    });
                }

                return cb(Fuse.ENOENT);
            },

            readdir(filePath: string, cb: (code: number, files?: string[]) => void) {
                const norm = filePath === '/' ? '' : (filePath.startsWith('/') ? filePath.substring(1) : filePath);
                const directChildren = self.db.getDirectChildren(norm);
                cb(0, directChildren.map((mapping) => path.basename(mapping.local_path)));
            },

            open(filePath: string, flags: number, cb: (code: number, fd?: number) => void) {
                const relPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
                const mapping = self.db.getMapping(relPath);
                if (mapping) {
                    if (mapping.is_dir === 1) return cb(Fuse.EISDIR);
                    const writable =
                        (flags & constants.O_WRONLY) === constants.O_WRONLY ||
                        (flags & constants.O_RDWR) === constants.O_RDWR ||
                        (flags & constants.O_TRUNC) === constants.O_TRUNC;
                    const openHandle = async () => {
                        const cachePath =
                            mapping.node_uid.startsWith('local-new-')
                                ? self.hydrator.getCachePath(mapping.node_uid)
                                : await self.hydrator.hydrateNode(mapping.node_uid, relPath);
                        const localFd = openSync(cachePath, flags);
                        const fd = self.nextFd++;
                        self.openHandles.set(fd, {
                            relPath,
                            nodeUid: mapping.node_uid,
                            cachePath,
                            localFd,
                            isDirty: writable && (flags & constants.O_TRUNC) === constants.O_TRUNC,
                            flags,
                        });
                        cb(0, fd);
                    };
                    openHandle().catch((err) => {
                        self.logger.error(`Failed to prepare ${relPath} for open:`, err);
                        cb(Fuse.EIO);
                    });
                    return;
                }
                cb(Fuse.ENOENT);
            },

            read(filePath: string, fd: number, buf: Buffer, len: number, pos: number, cb: (bytesRead: number) => void) {
                const relPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
                const mapping = self.db.getMapping(relPath);

                if (!mapping || !mapping.node_uid) {
                    return cb(Fuse.ENOENT);
                }

                const handle = self.openHandles.get(fd);
                if (handle) {
                    try {
                        return cb(readSync(handle.localFd, buf, 0, len, pos));
                    } catch (err) {
                        self.logger.error(`Error reading open cached file ${relPath}:`, err);
                        return cb(Fuse.EIO);
                    }
                }

                self.hydrator.hydrateNode(mapping.node_uid, relPath)
                    .then((cachePath) => {
                        let cacheFd: number | null = null;
                        try {
                            cacheFd = openSync(cachePath, 'r');
                            const bytesRead = readSync(cacheFd, buf, 0, len, pos);
                            cb(bytesRead);
                        } catch (err) {
                            self.logger.error(`Error reading cached file ${relPath}:`, err);
                            cb(Fuse.EIO);
                        } finally {
                            if (cacheFd !== null) {
                                try { closeSync(cacheFd); } catch {}
                            }
                        }
                    })
                    .catch((err) => {
                        self.logger.error(`Hydration failed on read for ${relPath}:`, err);
                        cb(Fuse.EIO);
                    });
            },

            create(filePath: string, mode: number, cb: (code: number, fd?: number) => void) {
                const relPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
                const tempUid = `local-new-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
                const cachePath = self.hydrator.getCachePath(tempUid);

                try {
                    const localFd = openSync(cachePath, 'w+');

                    self.db.setMapping({
                        local_path: relPath,
                        node_uid: tempUid,
                        is_dir: 0,
                        size: 0,
                        mtime: Date.now(),
                        sha1: '',
                        remote_revision_uid: '',
                        remote_mtime: Date.now(),
                    });

                    const fd = self.nextFd++;
                    self.openHandles.set(fd, {
                        relPath,
                        nodeUid: tempUid,
                        cachePath,
                        localFd,
                        isDirty: true,
                        flags: 0,
                    });

                    cb(0, fd);
                } catch (err: any) {
                    self.logger.error(`Failed to create file ${relPath}:`, err);
                    cb(Fuse.EIO);
                }
            },

            write(filePath: string, fd: number, buf: Buffer, len: number, pos: number, cb: (bytesWritten: number) => void) {
                const relPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
                let mapping = self.db.getMapping(relPath);

                if (!mapping) {
                    return cb(Fuse.ENOENT);
                }

                const handle = self.openHandles.get(fd);
                const cachePath = handle ? handle.cachePath : self.hydrator.getCachePath(mapping.node_uid);
                
                const performWrite = async () => {
                    const resolvedCachePath =
                        handle || existsSync(cachePath) || mapping!.node_uid.startsWith('local-new-')
                            ? cachePath
                            : await self.hydrator.hydrateNode(mapping!.node_uid, relPath);
                    let cacheFd: number | null = null;
                    let ownsCacheFd = false;
                    try {
                        if (handle) {
                            cacheFd = handle.localFd;
                        } else {
                            cacheFd = openSync(resolvedCachePath, existsSync(resolvedCachePath) ? 'r+' : 'w+');
                            ownsCacheFd = true;
                        }
                        const bytesWritten = writeSync(cacheFd, buf, 0, len, pos);
                        const st = statSync(resolvedCachePath);
                        mapping!.size = st.size;
                        mapping!.mtime = st.mtimeMs;
                        self.db.setMapping(mapping!);
                        self.db.setPendingFodUpload(relPath, mapping!.node_uid, resolvedCachePath);
                        if (handle) {
                            handle.isDirty = true;
                            handle.cachePath = resolvedCachePath;
                        } else {
                            self.scheduleBackgroundUpload(relPath, mapping!.node_uid, resolvedCachePath);
                        }
                        cb(bytesWritten);
                    } finally {
                        if (cacheFd !== null && ownsCacheFd) closeSync(cacheFd);
                    }
                };
                performWrite().catch((err) => {
                    self.logger.error(`Error writing to file ${relPath}:`, err);
                    cb(Fuse.EIO);
                });
            },

            truncate(filePath: string, size: number, cb: (code: number) => void) {
                const relPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
                const mapping = self.db.getMapping(relPath);
                if (!mapping) return cb(Fuse.ENOENT);

                const truncateFile = async () => {
                    const cachePath = mapping.node_uid.startsWith('local-new-')
                        ? self.hydrator.getCachePath(mapping.node_uid)
                        : await self.hydrator.hydrateNode(mapping.node_uid, relPath);
                    truncateSync(cachePath, size);
                    mapping.size = size;
                    mapping.mtime = Date.now();
                    self.db.setMapping(mapping);
                    self.db.setPendingFodUpload(relPath, mapping.node_uid, cachePath);
                    self.scheduleBackgroundUpload(relPath, mapping.node_uid, cachePath);
                    cb(0);
                };
                truncateFile().catch((err) => {
                    self.logger.error(`Failed to truncate file ${relPath}:`, err);
                    cb(Fuse.EIO);
                });
            },

            ftruncate(filePath: string, fd: number, size: number, cb: (code: number) => void) {
                const handle = self.openHandles.get(fd);
                if (handle) {
                    try {
                        ftruncateSync(handle.localFd, size);
                        handle.isDirty = true;
                        const mapping = self.db.getMapping(handle.relPath);
                        if (mapping) {
                            mapping.size = size;
                            mapping.mtime = Date.now();
                            self.db.setMapping(mapping);
                            self.db.setPendingFodUpload(handle.relPath, mapping.node_uid, handle.cachePath);
                        }
                        return cb(0);
                    } catch (err) {
                        self.logger.error(`Failed to ftruncate fd ${fd} (${handle.relPath}):`, err);
                        return cb(Fuse.EIO);
                    }
                }
                const relPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
                return ops.truncate(relPath, size, cb);
            },

            flush(filePath: string, fd: number, cb: (code: number) => void) {
                const handle = self.openHandles.get(fd);
                if (!handle?.isDirty) return cb(0);
                try {
                    fsyncSync(handle.localFd);
                    handle.isDirty = false;
                    self.scheduleBackgroundUpload(handle.relPath, handle.nodeUid, handle.cachePath);
                    cb(0);
                } catch (err) {
                    self.logger.error(`Failed to flush local cache for ${handle.relPath}:`, err);
                    cb(Fuse.EIO);
                }
            },

            fsync(filePath: string, fd: number, datasync: boolean, cb: (code: number) => void) {
                ops.flush(filePath, fd, cb);
            },

            release(filePath: string, fd: number, cb: (code: number) => void) {
                const handle = self.openHandles.get(fd);
                if (handle) {
                    if (handle.isDirty) {
                        self.scheduleBackgroundUpload(handle.relPath, handle.nodeUid, handle.cachePath);
                    }
                    self.openHandles.delete(fd);
                    try {
                        closeSync(handle.localFd);
                    } catch (err) {
                        self.logger.error(`Failed to close cached file ${handle.relPath}:`, err);
                        return cb(Fuse.EIO);
                    }
                }
                cb(0);
            },

            unlink(filePath: string, cb: (code: number) => void) {
                const relPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
                const mapping = self.db.getMapping(relPath);

                if (!mapping) {
                    return cb(Fuse.ENOENT);
                }

                self.deleteRemoteMapping(relPath, mapping)
                    .then(() => cb(0))
                    .catch((err) => {
                        self.logger.error(`Failed to unlink ${relPath}:`, err);
                        cb(Fuse.EIO);
                    });
            },

            mkdir(filePath: string, mode: number, cb: (code: number) => void) {
                const relPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
                self.createRemoteFolder(relPath)
                    .then(() => cb(0))
                    .catch((err) => {
                        self.logger.error(`Remote folder creation failed for ${relPath}:`, err);
                        cb(Fuse.EIO);
                    });
            },

            rmdir(filePath: string, cb: (code: number) => void) {
                const relPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
                const mapping = self.db.getMapping(relPath);

                if (!mapping) {
                    return cb(Fuse.ENOENT);
                }

                const children = self.db.getMappingsByPrefix(relPath);
                if (children.length > 0) {
                    return cb(Fuse.ENOTEMPTY);
                }

                self.deleteRemoteMapping(relPath, mapping)
                    .then(() => cb(0))
                    .catch((err) => {
                        self.logger.error(`Failed to remove directory ${relPath}:`, err);
                        cb(Fuse.EIO);
                    });
            },

            rename(srcPath: string, destPath: string, cb: (code: number) => void) {
                const srcRel = srcPath.startsWith('/') ? srcPath.substring(1) : srcPath;
                const destRel = destPath.startsWith('/') ? destPath.substring(1) : destPath;
                const mapping = self.db.getMapping(srcRel);

                if (!mapping) {
                    return cb(Fuse.ENOENT);
                }

                if (self.db.getMapping(destRel)) return cb(Fuse.EEXIST);
                self.renameRemoteMapping(srcRel, destRel, mapping)
                    .then(() => cb(0))
                    .catch((err) => {
                        self.logger.error(`Remote rename failed for ${srcRel} -> ${destRel}:`, err);
                        cb(Fuse.EIO);
                    });
            },

            statfs(filePath: string, cb: (code: number, fsStat?: any) => void) {
                cb(0, {
                    bsize: 4096,
                    frsize: 4096,
                    blocks: 10000000,
                    bfree: 8000000,
                    bavail: 8000000,
                    files: 1000000,
                    ffree: 800000,
                    favail: 800000,
                    fsid: 42,
                    flag: 0,
                    namemax: 255,
                });
            },
        };

        return new Promise<void>((resolve, reject) => {
            try {
                this.fuse = new Fuse(this.mountPoint, ops, { displayFolder: 'Proton Drive', force: true });
                this.fuse.mount((err: any) => {
                    if (err) {
                        this.logger.error('Failed to mount FUSE filesystem:', err);
                        return reject(err);
                    }
                    this.isMounted = true;
                    this.logger.info(`Proton Drive FUSE filesystem mounted cleanly on ${this.mountPoint}`);
                    this.resumePendingUploads();
                    resolve();
                });
            } catch (err) {
                this.logger.error('Error instantiating fuse-native:', err);
                reject(err);
            }
        });
    }

    private async getRemoteParentUid(relPath: string): Promise<string> {
        const parentPath = path.dirname(relPath);
        if (parentPath !== '.' && parentPath !== '') {
            const parentMapping = this.db.getMapping(parentPath);
            if (!parentMapping || parentMapping.is_dir !== 1 || parentMapping.node_uid.startsWith('local-')) {
                throw new Error(`Remote parent is not ready: ${parentPath}`);
            }
            return parentMapping.node_uid;
        }
        const root = await this.sdk.getMyFilesRootFolder();
        return root.uid;
    }

    private async createRemoteFolder(relPath: string): Promise<void> {
        const folderName = path.basename(relPath);
        const parentUid = await this.getRemoteParentUid(relPath);
        const newFolder = await this.sdk.createFolder(parentUid, folderName);
        this.db.setMapping({
            local_path: relPath,
            node_uid: newFolder.uid,
            is_dir: 1,
            size: 0,
            mtime: Date.now(),
            sha1: '',
            remote_revision_uid: '',
            remote_mtime: Date.now(),
        });
    }

    private async consumeNodeResults(results: AsyncIterable<any>): Promise<void> {
        for await (const result of results) {
            if (!result.ok) throw result.error;
        }
    }

    private async deleteRemoteMapping(relPath: string, mapping: any): Promise<void> {
        if (!mapping.node_uid.startsWith('local-')) {
            await this.consumeNodeResults(this.sdk.trashNodes([mapping.node_uid]));
        }
        const cachePath = this.hydrator.getCachePath(mapping.node_uid);
        if (existsSync(cachePath)) unlinkSync(cachePath);
        this.db.deletePendingFodUpload(relPath);
        this.db.deleteMapping(relPath);
        if (mapping.is_dir === 1) this.db.deleteMappingsByPrefix(relPath);
        this.db.log(relPath, 'delete_remote', 'completed', 'Cloud node moved to trash');
    }

    private async renameRemoteMapping(srcRel: string, destRel: string, mapping: any): Promise<void> {
        if (mapping.node_uid.startsWith('local-')) {
            throw new Error('Cannot rename a node before its remote creation has completed');
        }
        const oldName = path.basename(srcRel);
        const newName = path.basename(destRel);
        const oldParent = path.dirname(srcRel);
        const newParent = path.dirname(destRel);
        let renamed = false;
        if (oldName !== newName) {
            await this.sdk.renameNode(mapping.node_uid, newName);
            renamed = true;
        }
        try {
            if (oldParent !== newParent) {
                const newParentUid = await this.getRemoteParentUid(destRel);
                await this.consumeNodeResults(this.sdk.moveNodes([mapping.node_uid], newParentUid));
            }
        } catch (error) {
            if (renamed) await this.sdk.renameNode(mapping.node_uid, oldName).catch(() => {});
            throw error;
        }
        this.db.deleteMapping(srcRel);
        this.db.setMapping({ ...mapping, local_path: destRel });
        if (mapping.is_dir === 1) this.db.renameMappingsByPrefix(srcRel, destRel);
        this.db.log(destRel, 'rename_remote', 'completed', `Renamed ${srcRel} to ${destRel}`);
    }

    private scheduleBackgroundUpload(
        relPath: string,
        nodeUid: string,
        cachePath: string,
        delayMs = this.options.uploadDebounceMs ?? 750,
    ): void {
        this.db.setPendingFodUpload(relPath, nodeUid, cachePath);
        this.uploadGenerations.set(relPath, (this.uploadGenerations.get(relPath) ?? 0) + 1);

        const existingTimer = this.uploadTimers.get(relPath);
        if (existingTimer) clearTimeout(existingTimer);
        if (this.isPaused || !this.isMounted) return;

        const timer = setTimeout(() => {
            this.uploadTimers.delete(relPath);
            const pending = this.db.getPendingFodUploads().find((item) => item.local_path === relPath);
            if (!pending) return;
            void this.queueBackgroundUpload(
                relPath,
                pending.node_uid,
                pending.cache_path,
            ).catch((error) => {
                this.scheduleUploadRetry(relPath, pending.node_uid, pending.cache_path, error);
            });
        }, Math.max(0, delayMs));
        timer.unref();
        this.uploadTimers.set(relPath, timer);
    }

    private scheduleUploadRetry(relPath: string, nodeUid: string, cachePath: string, error: unknown): void {
        if (this.isPaused || !this.isMounted || !this.db.hasPendingFodUpload(relPath)) return;

        const pending = this.db.getPendingFodUploads().find((item) => item.local_path === relPath);
        const attempts = Math.max(1, pending?.attempts ?? 1);
        const baseDelay = this.options.uploadRetryBaseMs ?? 1_000;
        const maxDelay = this.options.uploadRetryMaxMs ?? 30_000;
        const retryDelay = Math.min(maxDelay, baseDelay * (2 ** Math.min(attempts - 1, 5)));
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
            `FUSE upload for ${relPath} remains queued; retrying in ${retryDelay}ms: ${message}`,
        );
        this.scheduleBackgroundUpload(relPath, nodeUid, cachePath, retryDelay);
    }

    private queueBackgroundUpload(relPath: string, nodeUid: string, cachePath: string): Promise<void> {
        const existing = this.uploadPromises.get(relPath);
        if (existing) {
            this.dirtyUploads.add(relPath);
            return existing.then(() => this.uploadPromises.get(relPath) ?? Promise.resolve());
        }

        this.db.setPendingFodUpload(relPath, nodeUid, cachePath);
        if (this.isPaused) {
            return Promise.reject(new Error('FUSE transfers are paused; upload remains queued'));
        }
        const uploadInfo = {
            nodeUid,
            filePath: relPath,
            localPath: relPath,
            transferred: 0,
            size: existsSync(cachePath) ? statSync(cachePath).size : 0,
            percent: 0,
            type: 'upload',
        };

        this.activeUploads.set(relPath, uploadInfo);
        this.emit('upload_start', uploadInfo);
        this.db.log(relPath, 'upload', 'syncing', `Starting upload for ${relPath}`);
        const uploadGeneration = this.uploadGenerations.get(relPath) ?? 0;

        const promise = this.performUpload(relPath, nodeUid, cachePath, uploadInfo)
            .then(() => {
                if ((this.uploadGenerations.get(relPath) ?? 0) === uploadGeneration) {
                    this.db.deletePendingFodUpload(relPath);
                    this.uploadGenerations.delete(relPath);
                }
                this.emit('upload_complete', uploadInfo);
            })
            .catch((err: any) => {
                const message = err?.message || String(err);
                this.db.markPendingFodUploadFailed(relPath, message);
                this.db.log(relPath, 'upload', 'failed', `Upload failed for ${relPath}: ${message}`);
                this.emit('upload_error', { ...uploadInfo, error: message });
                throw err;
            })
            .finally(() => {
                this.activeUploads.delete(relPath);
                this.uploadPromises.delete(relPath);
                if (this.dirtyUploads.delete(relPath)) {
                    const mapping = this.db.getMapping(relPath);
                    if (mapping) {
                        const nextCachePath = this.hydrator.getCachePath(mapping.node_uid);
                        this.scheduleBackgroundUpload(relPath, mapping.node_uid, nextCachePath);
                    }
                }
            });
        this.uploadPromises.set(relPath, promise);
        return promise;
    }

    private async performUpload(relPath: string, nodeUid: string, cachePath: string, uploadInfo: any): Promise<void> {
        if (!existsSync(cachePath)) throw new Error(`Cached writeback file is missing: ${cachePath}`);

        const before = statSync(cachePath);
        const snapshotPath = `${cachePath}.upload-${randomUUID()}`;
        await copyFile(cachePath, snapshotPath, constants.COPYFILE_FICLONE);
        const afterSnapshot = statSync(cachePath);
        if (
            afterSnapshot.size !== before.size ||
            afterSnapshot.mtimeMs !== before.mtimeMs ||
            afterSnapshot.ctimeMs !== before.ctimeMs
        ) {
            await unlinkFile(snapshotPath).catch(() => {});
            throw new Error(`Cached file changed while creating upload snapshot: ${relPath}`);
        }

        const size = before.size;
        const mtime = before.mtimeMs;
        try {
            const sha1 = await getSha1(snapshotPath);
            uploadInfo.size = size;
            const metadata = {
                mediaType: 'application/octet-stream',
                expectedSize: size,
                expectedSha1: sha1,
                modificationTime: new Date(mtime),
            };
            let lastProgressEmit = 0;
            const progress = (bytes: number) => {
                uploadInfo.transferred = Math.min(bytes, size);
                uploadInfo.percent = size > 0 ? Math.min(100, Math.round((bytes / size) * 100)) : 100;
                const now = Date.now();
                if (now - lastProgressEmit >= 200 || bytes >= size) {
                    this.emit('upload_progress', uploadInfo);
                    lastProgressEmit = now;
                }
            };

            const isNew = nodeUid.startsWith('local-new-');
            let effectiveNodeUid = nodeUid;
            let createNew = isNew;
            let recoveredDraft = false;
            let uploadResult: { nodeUid?: string; nodeRevisionUid?: string };

            while (true) {
                try {
                    let uploader: any;
                    if (createNew) {
                        const parentUid = await this.getRemoteParentUid(relPath);
                        uploader = await this.sdk.getFileUploader(parentUid, path.basename(relPath), metadata);
                    } else {
                        uploader = await this.sdk.getFileRevisionUploader(effectiveNodeUid, metadata);
                    }
                    const controller = await uploader.uploadFromStream(
                        openFileReadableStream(snapshotPath) as any,
                        [],
                        progress,
                    );
                    uploadResult = await controller.completion();
                    break;
                } catch (error: any) {
                    if (createNew && error?.existingNodeUid) {
                        effectiveNodeUid = error.existingNodeUid;
                        createNew = false;
                        continue;
                    }

                    const draftRevisionUid = error?.details?.ConflictDraftRevisionID;
                    const conflictClientUid = error?.details?.ConflictDraftClientUID;
                    const isOwnDraft =
                        typeof draftRevisionUid === 'string' &&
                        Boolean(this.options.clientUid) &&
                        conflictClientUid === this.options.clientUid;
                    if (
                        !recoveredDraft &&
                        !createNew &&
                        isOwnDraft &&
                        typeof this.sdk.deleteRevision === 'function'
                    ) {
                        recoveredDraft = true;
                        this.logger.warn(
                            `Removing stale local-client draft revision for ${relPath} and retrying upload`,
                        );
                        try {
                            await this.sdk.deleteRevision(`${effectiveNodeUid}~${draftRevisionUid}`);
                        } catch (deleteError) {
                            this.logger.error(
                                `Failed to remove stale draft revision for ${relPath}:`,
                                deleteError,
                            );
                            throw error;
                        }
                        continue;
                    }
                    throw error;
                }
            }

            const finalNodeUid = uploadResult.nodeUid || effectiveNodeUid;
            const finalCachePath = await this.hydrator.rekeyCachedFile(nodeUid, finalNodeUid);
            for (const handle of this.openHandles.values()) {
                if (handle.relPath === relPath && handle.nodeUid === nodeUid) {
                    handle.nodeUid = finalNodeUid;
                    handle.cachePath = finalCachePath;
                }
            }
            this.db.setMapping({
                local_path: relPath,
                node_uid: finalNodeUid,
                is_dir: 0,
                size,
                mtime,
                sha1,
                remote_revision_uid: uploadResult.nodeRevisionUid || '',
                remote_mtime: mtime,
            });
            this.db.setPendingFodUpload(relPath, finalNodeUid, finalCachePath);
            uploadInfo.nodeUid = finalNodeUid;
            uploadInfo.percent = 100;
            uploadInfo.transferred = size;
            this.db.log(relPath, 'upload', 'completed', `Successfully uploaded ${relPath}`);
        } finally {
            await unlinkFile(snapshotPath).catch(() => {});
        }
    }

    private resumePendingUploads(): void {
        if (this.isPaused || !this.isMounted) return;
        for (const pending of this.db.getPendingFodUploads()) {
            if (!existsSync(pending.cache_path)) {
                this.db.markPendingFodUploadFailed(
                    pending.local_path,
                    `Cached writeback file is missing: ${pending.cache_path}`,
                );
                continue;
            }
            this.scheduleBackgroundUpload(
                pending.local_path,
                pending.node_uid,
                pending.cache_path,
                0,
            );
        }
    }

    async unmount(): Promise<void> {
        for (const timer of this.uploadTimers.values()) clearTimeout(timer);
        this.uploadTimers.clear();
        for (const handle of this.openHandles.values()) {
            try {
                closeSync(handle.localFd);
            } catch {}
        }
        this.openHandles.clear();
        if (!this.isMounted) return;
        return new Promise<void>((resolve) => {
            if (this.fuse) {
                this.fuse.unmount(() => {
                    this.isMounted = false;
                    resolve();
                });
            } else {
                this.isMounted = false;
                resolve();
            }
        });
    }
}
