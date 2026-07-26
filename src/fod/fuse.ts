import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { exec } from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import Fuse from 'fuse-native';
import { SyncDatabase, SyncMapping } from '../sync/db';
import { FodHydrator } from './hydrator';
import { FodHooks } from '../sync/dashboard';

export class ProtonFuseEngine extends EventEmitter implements FodHooks {
    public isFuseMode: boolean = true;
    public mountPoint: string;
    private fuse: any = null;
    private hydrator: FodHydrator;
    private openFileHandles: Map<number, { nodeUid: string; cachePath: string; isWrite: boolean }> = new Map();
    private nextFd: number = 10;
    private activeUploadsList: any[] = [];
    private isMounted: boolean = false;

    constructor(
        private db: SyncDatabase,
        private sdk: any,
        private auth: any,
        private logger: any,
        mountPoint?: string,
    ) {
        super();
        const home = process.env.HOME || '/tmp';
        this.mountPoint = mountPoint || db.getFuseMountPoint() || path.join(home, 'P-Drive-FUSE');
        this.hydrator = new FodHydrator(db, sdk, logger);
        this.setupProcessExitHandlers();
    }

    private setupProcessExitHandlers(): void {
        const cleanup = () => {
            if (this.isMounted) {
                this.unmountSync();
            }
        };
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
        process.on('exit', cleanup);
    }

    private unmountSync(): void {
        try {
            exec(`fusermount -u -z "${this.mountPoint}" 2>/dev/null || umount -l "${this.mountPoint}" 2>/dev/null`);
            this.isMounted = false;
        } catch {}
    }

    async start(): Promise<void> {
        this.logger.info(`Starting Proton Drive FUSE Mode on mount point: ${this.mountPoint}`);
        mkdirSync(this.mountPoint, { recursive: true });

        // Clean up any stale or broken mount points from a previous crash
        this.unmountSync();

        const ops = {
            readdir: (relPath: string, cb: (err: number, names?: string[]) => void) => {
                const normPath = this.normalizePath(relPath);
                try {
                    const mappings = this.db.getAllMappings();
                    const childrenNames = new Set<string>();

                    for (const m of mappings) {
                        if (normPath === '') {
                            const topName = m.local_path.split('/')[0];
                            if (topName) childrenNames.add(topName);
                        } else {
                            if (m.local_path.startsWith(normPath + '/')) {
                                const subPath = m.local_path.slice(normPath.length + 1);
                                const childName = subPath.split('/')[0];
                                if (childName) childrenNames.add(childName);
                            }
                        }
                    }
                    return cb(0, Array.from(childrenNames));
                } catch (err) {
                    this.logger.error(`FUSE readdir error for ${relPath}:`, err);
                    return cb(Fuse.EIO);
                }
            },

            getattr: (relPath: string, cb: (err: number, stat?: any) => void) => {
                const normPath = this.normalizePath(relPath);
                if (normPath === '') {
                    return cb(0, {
                        mtime: new Date(),
                        atime: new Date(),
                        ctime: new Date(),
                        size: 4096,
                        mode: 0o40755,
                        nlink: 2,
                        uid: process.getuid ? process.getuid() : 1000,
                        gid: process.getgid ? process.getgid() : 1000,
                    });
                }

                const mapping = this.db.getMapping(normPath);
                if (!mapping) {
                    // Check if it's an intermediate directory
                    const mappings = this.db.getAllMappings();
                    const isDir = mappings.some(m => m.local_path.startsWith(normPath + '/'));
                    if (isDir) {
                        return cb(0, {
                            mtime: new Date(),
                            atime: new Date(),
                            ctime: new Date(),
                            size: 4096,
                            mode: 0o40755,
                            nlink: 2,
                            uid: process.getuid ? process.getuid() : 1000,
                            gid: process.getgid ? process.getgid() : 1000,
                        });
                    }
                    return cb(Fuse.ENOENT);
                }

                const isDir = mapping.is_dir === 1;
                const mtime = new Date(mapping.mtime || Date.now());
                return cb(0, {
                    mtime,
                    atime: mtime,
                    ctime: mtime,
                    size: isDir ? 4096 : mapping.size,
                    mode: isDir ? 0o40755 : 0o10644,
                    nlink: isDir ? 2 : 1,
                    uid: process.getuid ? process.getuid() : 1000,
                    gid: process.getgid ? process.getgid() : 1000,
                });
            },

            open: (relPath: string, flags: number, cb: (err: number, fd?: number) => void) => {
                const normPath = this.normalizePath(relPath);
                const mapping = this.db.getMapping(normPath);
                if (!mapping) return cb(Fuse.ENOENT);

                const fd = this.nextFd++;
                const isWrite = (flags & 3) !== 0; // O_WRONLY or O_RDWR
                const cachePath = this.hydrator.getCachePath(mapping.node_uid);

                this.openFileHandles.set(fd, {
                    nodeUid: mapping.node_uid,
                    cachePath,
                    isWrite,
                });

                return cb(0, fd);
            },

            read: async (relPath: string, fd: number, buf: Buffer, len: number, pos: number, cb: (bytesRead: number) => void) => {
                const normPath = this.normalizePath(relPath);
                const mapping = this.db.getMapping(normPath);
                if (!mapping) return cb(Fuse.ENOENT);

                try {
                    const cachePath = await this.hydrator.hydrateNode(mapping.node_uid, normPath);
                    const fileBuf = readFileSync(cachePath);
                    const bytesToRead = Math.min(len, Math.max(0, fileBuf.length - pos));
                    if (bytesToRead > 0) {
                        fileBuf.copy(buf, 0, pos, pos + bytesToRead);
                    }
                    return cb(bytesToRead);
                } catch (err) {
                    this.logger.error(`FUSE read error for ${normPath}:`, err);
                    return cb(Fuse.EIO);
                }
            },

            write: (relPath: string, fd: number, buf: Buffer, len: number, pos: number, cb: (bytesWritten: number) => void) => {
                const handle = this.openFileHandles.get(fd);
                if (!handle) return cb(Fuse.EBADF);

                try {
                    let fileBuf = existsSync(handle.cachePath) ? readFileSync(handle.cachePath) : Buffer.alloc(0);
                    if (pos + len > fileBuf.length) {
                        const newBuf = Buffer.alloc(pos + len);
                        fileBuf.copy(newBuf, 0, 0, fileBuf.length);
                        fileBuf = newBuf;
                    }
                    buf.copy(fileBuf, pos, 0, len);
                    writeFileSync(handle.cachePath, fileBuf);
                    return cb(len);
                } catch (err) {
                    this.logger.error(`FUSE write error for ${relPath}:`, err);
                    return cb(Fuse.EIO);
                }
            },

            release: async (relPath: string, fd: number, cb: (err: number) => void) => {
                const handle = this.openFileHandles.get(fd);
                this.openFileHandles.delete(fd);
                if (handle && handle.isWrite) {
                    const normPath = this.normalizePath(relPath);
                    this.logger.info(`FUSE file closed after writing: ${normPath}. Uploading to Proton Cloud...`);
                    try {
                        const mapping = this.db.getMapping(normPath);
                        if (mapping) {
                            const node = await this.sdk.getNode(mapping.node_uid);
                            const uploader = await this.sdk.getFileRevisionUploader(node);
                            const bunFile = Bun.file(handle.cachePath);
                            const uploadController = uploader.uploadFromStream({
                                getWriter: () => bunFile.writer(),
                                locked: false,
                            } as any);
                            await uploadController.completion();
                            this.logger.info(`FUSE upload complete for ${normPath}`);
                        }
                    } catch (err) {
                        this.logger.error(`FUSE background upload failed for ${normPath}:`, err);
                    }
                }
                return cb(0);
            },

            unlink: async (relPath: string, cb: (err: number) => void) => {
                const normPath = this.normalizePath(relPath);
                const mapping = this.db.getMapping(normPath);
                if (mapping) {
                    try {
                        await this.sdk.trashNodes([mapping.node_uid]);
                        await this.hydrator.evictFile(mapping.node_uid);
                        this.db.deleteMapping(normPath);
                        return cb(0);
                    } catch (err) {
                        this.logger.error(`FUSE unlink error for ${normPath}:`, err);
                        return cb(Fuse.EIO);
                    }
                }
                return cb(Fuse.ENOENT);
            },

            mkdir: async (relPath: string, mode: number, cb: (err: number) => void) => {
                const normPath = this.normalizePath(relPath);
                const parentPath = path.dirname(normPath);
                const folderName = path.basename(normPath);
                let parentUid = '';

                if (parentPath !== '.') {
                    const parentMapping = this.db.getMapping(parentPath);
                    if (!parentMapping) return cb(Fuse.ENOENT);
                    parentUid = parentMapping.node_uid;
                } else {
                    const rootFolder = await this.sdk.getMyFilesRootFolder();
                    parentUid = rootFolder.uid;
                }

                try {
                    const newFolder = await this.sdk.createFolder(parentUid, folderName);
                    this.db.setMapping({
                        local_path: normPath,
                        node_uid: newFolder.uid,
                        is_dir: 1,
                        size: 0,
                        mtime: Date.now(),
                        sha1: '',
                        remote_revision_uid: '',
                        remote_mtime: Date.now(),
                    });
                    return cb(0);
                } catch (err) {
                    this.logger.error(`FUSE mkdir error for ${normPath}:`, err);
                    return cb(Fuse.EIO);
                }
            },

            statfs: (relPath: string, cb: (err: number, stat?: any) => void) => {
                return cb(0, {
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

        this.fuse = new Fuse(this.mountPoint, ops, { displayFolder: 'Proton Drive', force: true, mkdir: true });

        await new Promise<void>((resolve, reject) => {
            this.fuse.mount((err: any) => {
                if (err) {
                    this.logger.error(`Failed to mount FUSE on ${this.mountPoint}:`, err);
                    return reject(err);
                }
                this.isMounted = true;
                this.logger.info(`Proton Drive FUSE filesystem mounted cleanly on ${this.mountPoint}`);
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        this.logger.info('Stopping Proton Drive FUSE Engine...');
        if (this.fuse && this.isMounted) {
            await new Promise<void>((resolve) => {
                this.fuse.unmount(() => {
                    this.isMounted = false;
                    resolve();
                });
            });
        }
        this.unmountSync();
        this.logger.info('Proton Drive FUSE Engine stopped.');
    }

    private normalizePath(relPath: string): string {
        return relPath.replace(/^\//, '').replace(/\/$/, '');
    }

    // FodHooks implementation
    getInodes(): any[] {
        return this.db.getAllMappings();
    }

    getCached(): any[] {
        return this.hydrator.getCachedFiles();
    }

    getCacheStats(): { totalFiles: number; totalBytes: number } {
        return this.hydrator.getCacheStats();
    }

    async evictFile(nodeUid: string): Promise<boolean> {
        return await this.hydrator.evictFile(nodeUid);
    }

    async pinFile(nodeUid: string): Promise<boolean> {
        return await this.hydrator.pinFile(nodeUid);
    }

    getUploads(): any[] {
        return this.activeUploadsList;
    }
}
