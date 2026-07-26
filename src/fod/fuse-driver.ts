import { existsSync, openSync, readSync, writeSync, closeSync, unlinkSync, mkdirSync, statSync, truncateSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import Fuse from 'fuse-native';
import { SyncDatabase } from '../sync/db';
import { FodHydrator } from './hydrator';

interface OpenHandle {
    relPath: string;
    nodeUid: string;
    cachePath: string;
    isDirty: boolean;
    flags: number;
}

export class FuseDriver extends EventEmitter {
    private fuse: any = null;
    private isMounted: boolean = false;
    private activeUploads: Map<string, any> = new Map();
    private dirtyUploads: Set<string> = new Set();
    private nextFd: number = 100;
    private openHandles: Map<number, OpenHandle> = new Map();

    constructor(
        private mountPoint: string,
        private db: SyncDatabase,
        private hydrator: FodHydrator,
        private sdk: any,
        private logger: any,
    ) {
        super();
    }

    getActiveUploads(): any[] {
        return Array.from(this.activeUploads.values());
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
                const hasChildren = self.db.getMappingsByPrefix(relPath).length > 0;

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
                const prefixMappings = norm === '' ? self.db.getAllMappings() : self.db.getMappingsByPrefix(norm);
                const entriesSet = new Set<string>();

                const normLen = norm.length;
                for (const m of prefixMappings) {
                    const lp = m.local_path;
                    if (!lp) continue;

                    if (normLen === 0) {
                        const slashIdx = lp.indexOf('/');
                        const entry = slashIdx !== -1 ? lp.substring(0, slashIdx) : lp;
                        if (entry) entriesSet.add(entry);
                    } else if (lp.startsWith(norm + '/')) {
                        const sub = lp.substring(normLen + 1);
                        const slashIdx = sub.indexOf('/');
                        const entry = slashIdx !== -1 ? sub.substring(0, slashIdx) : sub;
                        if (entry) entriesSet.add(entry);
                    }
                }

                cb(0, Array.from(entriesSet));
            },

            open(filePath: string, flags: number, cb: (code: number, fd?: number) => void) {
                const relPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
                const mapping = self.db.getMapping(relPath);
                if (mapping) {
                    const fd = self.nextFd++;
                    const cachePath = self.hydrator.getCachePath(mapping.node_uid);
                    self.openHandles.set(fd, {
                        relPath,
                        nodeUid: mapping.node_uid,
                        cachePath,
                        isDirty: false,
                        flags,
                    });
                    return cb(0, fd);
                }
                cb(Fuse.ENOENT);
            },

            read(filePath: string, fd: number, buf: Buffer, len: number, pos: number, cb: (bytesRead: number) => void) {
                const relPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
                const mapping = self.db.getMapping(relPath);

                if (!mapping || !mapping.node_uid) {
                    return cb(Fuse.ENOENT);
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
                    closeSync(localFd);

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
                
                let cacheFd: number | null = null;
                try {
                    cacheFd = openSync(cachePath, existsSync(cachePath) ? 'r+' : 'w+');
                    const bytesWritten = writeSync(cacheFd, buf, 0, len, pos);
                    
                    const st = statSync(cachePath);
                    mapping.size = st.size;
                    mapping.mtime = st.mtimeMs;
                    self.db.setMapping(mapping);

                    if (handle) {
                        handle.isDirty = true;
                    } else {
                        self.queueBackgroundUpload(relPath, mapping.node_uid, cachePath);
                    }

                    cb(bytesWritten);
                } catch (err: any) {
                    self.logger.error(`Error writing to file ${relPath}:`, err);
                    cb(Fuse.EIO);
                } finally {
                    if (cacheFd !== null) {
                        try { closeSync(cacheFd); } catch {}
                    }
                }
            },

            truncate(filePath: string, size: number, cb: (code: number) => void) {
                const relPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
                const mapping = self.db.getMapping(relPath);
                if (!mapping) return cb(Fuse.ENOENT);

                const cachePath = self.hydrator.getCachePath(mapping.node_uid);
                try {
                    if (existsSync(cachePath)) {
                        truncateSync(cachePath, size);
                    }
                    mapping.size = size;
                    mapping.mtime = Date.now();
                    self.db.setMapping(mapping);
                    self.queueBackgroundUpload(relPath, mapping.node_uid, cachePath);
                    cb(0);
                } catch (err) {
                    self.logger.error(`Failed to truncate file ${relPath}:`, err);
                    cb(Fuse.EIO);
                }
            },

            ftruncate(filePath: string, fd: number, size: number, cb: (code: number) => void) {
                const handle = self.openHandles.get(fd);
                if (handle) {
                    try {
                        if (existsSync(handle.cachePath)) {
                            truncateSync(handle.cachePath, size);
                        }
                        handle.isDirty = true;
                        const mapping = self.db.getMapping(handle.relPath);
                        if (mapping) {
                            mapping.size = size;
                            mapping.mtime = Date.now();
                            self.db.setMapping(mapping);
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
                cb(0);
            },

            release(filePath: string, fd: number, cb: (code: number) => void) {
                const handle = self.openHandles.get(fd);
                if (handle) {
                    if (handle.isDirty) {
                        self.queueBackgroundUpload(handle.relPath, handle.nodeUid, handle.cachePath);
                    }
                    self.openHandles.delete(fd);
                }
                cb(0);
            },

            unlink(filePath: string, cb: (code: number) => void) {
                const relPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
                const mapping = self.db.getMapping(relPath);

                if (!mapping) {
                    return cb(Fuse.ENOENT);
                }

                const cachePath = self.hydrator.getCachePath(mapping.node_uid);
                if (existsSync(cachePath)) {
                    try { unlinkSync(cachePath); } catch {}
                }
                self.db.deleteMapping(relPath);

                if (mapping.node_uid && !mapping.node_uid.startsWith('local-new-')) {
                    self.sdk.trashNodes([mapping.node_uid]).catch((err: any) => {
                        self.logger.warn(`Failed to trash remote node ${mapping.node_uid}:`, err);
                    });
                }
                cb(0);
            },

            mkdir(filePath: string, mode: number, cb: (code: number) => void) {
                const relPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
                const tempUid = `local-folder-${Date.now()}`;

                self.db.setMapping({
                    local_path: relPath,
                    node_uid: tempUid,
                    is_dir: 1,
                    size: 0,
                    mtime: Date.now(),
                    sha1: '',
                    remote_revision_uid: '',
                    remote_mtime: Date.now(),
                });

                // Create folder remotely
                self.createRemoteFolder(relPath, tempUid).catch((err) => {
                    self.logger.error(`Remote folder creation failed for ${relPath}:`, err);
                });

                cb(0);
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

                self.db.deleteMapping(relPath);
                if (mapping.node_uid && !mapping.node_uid.startsWith('local-folder-')) {
                    self.sdk.trashNodes([mapping.node_uid]).catch((err: any) => {
                        self.logger.warn(`Failed to trash remote folder ${mapping.node_uid}:`, err);
                    });
                }
                cb(0);
            },

            rename(srcPath: string, destPath: string, cb: (code: number) => void) {
                const srcRel = srcPath.startsWith('/') ? srcPath.substring(1) : srcPath;
                const destRel = destPath.startsWith('/') ? destPath.substring(1) : destPath;
                const mapping = self.db.getMapping(srcRel);

                if (!mapping) {
                    return cb(Fuse.ENOENT);
                }

                self.db.deleteMapping(srcRel);
                mapping.local_path = destRel;
                self.db.setMapping(mapping);

                if (mapping.is_dir === 1) {
                    self.db.renameMappingsByPrefix(srcRel, destRel);
                }

                if (mapping.node_uid && !mapping.node_uid.startsWith('local-')) {
                    const destName = path.basename(destRel);
                    self.sdk.renameNode(mapping.node_uid, destName).catch((err: any) => {
                        self.logger.warn(`Remote rename failed for ${srcRel} -> ${destRel}:`, err);
                    });
                }
                cb(0);
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
                    resolve();
                });
            } catch (err) {
                this.logger.error('Error instantiating fuse-native:', err);
                reject(err);
            }
        });
    }

    private async createRemoteFolder(relPath: string, tempUid: string): Promise<void> {
        const parentPath = path.dirname(relPath);
        const folderName = path.basename(relPath);
        let parentUid = '';

        if (parentPath !== '.' && parentPath !== '') {
            const parentMapping = this.db.getMapping(parentPath);
            if (parentMapping) parentUid = parentMapping.node_uid;
        }

        if (!parentUid) {
            const root = await this.sdk.getMyFilesRootFolder();
            parentUid = root.uid;
        }

        const newFolder = await this.sdk.createFolder(parentUid, folderName);
        this.db.deleteMapping(relPath);
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

    private queueBackgroundUpload(relPath: string, nodeUid: string, cachePath: string): void {
        if (this.activeUploads.has(relPath)) {
            this.dirtyUploads.add(relPath);
            return;
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

        this.performUpload(relPath, nodeUid, cachePath, uploadInfo).finally(() => {
            this.activeUploads.delete(relPath);
            this.emit('upload_complete', uploadInfo);
            if (this.dirtyUploads.has(relPath)) {
                this.dirtyUploads.delete(relPath);
                this.queueBackgroundUpload(relPath, nodeUid, cachePath);
            }
        });
    }

    private async performUpload(relPath: string, nodeUid: string, cachePath: string, uploadInfo: any): Promise<void> {
        try {
            const size = existsSync(cachePath) ? statSync(cachePath).size : 0;
            uploadInfo.size = size;

            const fileName = path.basename(relPath);
            const parentPath = path.dirname(relPath);
            let parentUid = '';

            if (parentPath !== '.' && parentPath !== '') {
                const parentMapping = this.db.getMapping(parentPath);
                if (parentMapping) parentUid = parentMapping.node_uid;
            }

            if (!parentUid) {
                const root = await this.sdk.getMyFilesRootFolder();
                parentUid = root.uid;
            }

            const fileData = existsSync(cachePath) ? readFileSync(cachePath) : Buffer.alloc(0);
            const fileObj = new Blob([fileData]);

            // Perform upload via SDK
            const createdNode = await this.sdk.uploadFile({
                parentUid,
                name: fileName,
                file: fileObj,
                onProgress: (bytes: number) => {
                    uploadInfo.transferred = bytes;
                    uploadInfo.percent = size > 0 ? Math.min(100, Math.round((bytes / size) * 100)) : 100;
                    this.emit('upload_progress', uploadInfo);
                },
            });

            // Update mapping in SQLite
            const newUid = createdNode?.uid || nodeUid;
            this.db.setMapping({
                local_path: relPath,
                node_uid: newUid,
                is_dir: 0,
                size,
                mtime: Date.now(),
                sha1: '',
                remote_revision_uid: (createdNode?.activeRevision as any)?.value?.id || '',
                remote_mtime: Date.now(),
            });

            uploadInfo.percent = 100;
            uploadInfo.transferred = size;
            this.db.log(relPath, 'upload', 'completed', `Successfully uploaded ${relPath}`);
        } catch (err: any) {
            this.logger.error(`Failed to upload ${relPath}:`, err);
            this.db.log(relPath, 'upload', 'failed', `Upload failed for ${relPath}: ${err?.message || err}`);
        }
    }

    async unmount(): Promise<void> {
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
