import { existsSync, mkdirSync } from 'node:fs';
import { exec } from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { NodeType } from '@protontech/drive-sdk';
import { SyncDatabase } from '../sync/db';
import { FodHydrator, ActiveTransferInfo } from './hydrator';
import { FuseDriver } from './fuse-driver';
import { FodHooks } from '../sync/dashboard';

export class ProtonFuseEngine extends EventEmitter implements FodHooks {
    public isFuseMode: boolean = true;
    public mountPoint: string;
    private hydrator: FodHydrator;
    private fuseDriver: FuseDriver | null = null;
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
        
        // Forward hydration progress events for UI real-time SSE stream
        this.hydrator.on('progress', (info) => this.emit('transfersChanged', info));
        this.hydrator.on('start', (info) => this.emit('transfersChanged', info));
        this.hydrator.on('complete', (info) => this.emit('transfersChanged', info));

        this.setupProcessExitHandlers();
    }

    private setupProcessExitHandlers(): void {
        const cleanup = () => {
            if (this.isMounted) {
                this.unmountSync();
            }
        };
        process.once('exit', cleanup);
        process.once('SIGINT', cleanup);
        process.once('SIGTERM', cleanup);
        process.once('uncaughtException', (err) => {
            this.logger?.error?.('Uncaught exception in FUSE engine:', err);
            cleanup();
        });
    }

    private unmountSync(): void {
        try {
            if (this.fuseDriver) {
                this.fuseDriver.unmount().catch(() => {});
                this.fuseDriver = null;
            }
            exec(`fusermount -u -z "${this.mountPoint}" 2>/dev/null || umount -l "${this.mountPoint}" 2>/dev/null`);
            this.isMounted = false;
        } catch {}
    }

    async start(): Promise<void> {
        this.logger.info(`Starting Proton Drive FUSE Mode on mount point: ${this.mountPoint}`);
        mkdirSync(this.mountPoint, { recursive: true });

        // Clean up any stale mount point from a previous crash
        this.unmountSync();

        // Perform background remote cloud scan so SQLite database has all cloud file mappings
        this.scanRemoteTree().catch((err) => {
            this.logger.error('FUSE background remote scan error:', err);
        });

        this.fuseDriver = new FuseDriver(this.mountPoint, this.db, this.hydrator, this.sdk, this.logger);

        // Forward upload events from FUSE driver to UI
        this.fuseDriver.on('upload_start', (info) => this.emit('transfersChanged', info));
        this.fuseDriver.on('upload_progress', (info) => this.emit('transfersChanged', info));
        this.fuseDriver.on('upload_complete', (info) => this.emit('transfersChanged', info));

        try {
            await this.fuseDriver.mount();
            this.isMounted = true;
            this.logger.info(`Proton Drive FUSE filesystem mounted cleanly on ${this.mountPoint}`);
        } catch (err: any) {
            this.logger.error(`Failed to mount native TypeScript FUSE filesystem: ${err?.message || err}`);
            throw err;
        }
    }

    public async scanRemoteTree(): Promise<void> {
        this.logger.info('FUSE Mode: Syncing remote cloud directory structure...');
        try {
            const rootFolder = await this.sdk.getMyFilesRootFolder();
            const queue: { uid: string; relPath: string }[] = [{ uid: rootFolder.uid, relPath: '' }];
            let mappedCount = 0;
            let activeWorkers = 0;

            const processNode = (currentRelPath: string, node: any) => {
                if ('missingUid' in node || node.trashTime) return;

                const name = node.name.ok ? node.name.value : 'degraded_name';
                const relPath = currentRelPath ? `${currentRelPath}/${name}` : name;
                const isDir = node.type === NodeType.Folder || node.type === 2;
                const rev = node.activeRevision?.ok ? node.activeRevision.value : null;
                const size = rev
                    ? (rev.claimedSize ?? rev.size ?? rev.storageSize ?? 0)
                    : ((node as any).totalStorageSize ?? (node as any).size ?? (node as any).claimedSize ?? 0);
                const remoteRevUid = rev ? (rev.uid ?? rev.id ?? '') : '';
                const sha1 = rev?.claimedDigests?.sha1 || '';

                mappedCount++;
                this.db.setMapping({
                    local_path: relPath,
                    node_uid: node.uid,
                    is_dir: isDir ? 1 : 0,
                    size,
                    mtime: node.modificationTime ? new Date(node.modificationTime).getTime() : Date.now(),
                    sha1,
                    remote_revision_uid: remoteRevUid,
                    remote_mtime: node.modificationTime ? new Date(node.modificationTime).getTime() : Date.now(),
                });

                if (isDir) {
                    queue.push({ uid: node.uid, relPath });
                }
            };

            const workerCount = 5;
            const workers = Array.from({ length: workerCount }, async () => {
                while (true) {
                    if (queue.length === 0) {
                        if (activeWorkers === 0) break;
                        await new Promise((r) => setTimeout(r, 25));
                        continue;
                    }

                    const current = queue.shift();
                    if (!current) continue;

                    activeWorkers++;
                    try {
                        const childrenUids: string[] = [];
                        for await (const uid of this.sdk.iterateFolderChildrenNodeUids(current.uid)) {
                            childrenUids.push(uid);
                        }

                        const chunkSize = 15;
                        for (let i = 0; i < childrenUids.length; i += chunkSize) {
                            const chunk = childrenUids.slice(i, i + chunkSize);
                            try {
                                for await (const node of this.sdk.iterateNodes(chunk)) {
                                    processNode(current.relPath, node);
                                }
                            } catch {
                                for (const singleUid of chunk) {
                                    try {
                                        for await (const node of this.sdk.iterateNodes([singleUid])) {
                                            processNode(current.relPath, node);
                                        }
                                    } catch {}
                                }
                            }
                        }
                    } catch (folderErr) {
                        this.logger.error(`Error scanning folder ${current.relPath}:`, folderErr);
                    } finally {
                        activeWorkers--;
                    }
                }
            });

            await Promise.all(workers);
            this.logger.info(`FUSE Mode: Remote directory structure sync complete. Mapped ${mappedCount} items.`);
            this.db.log('system', 'system', 'completed', `FUSE Mode: Mapped ${mappedCount} cloud items.`);
        } catch (err) {
            this.logger.error('FUSE Mode: Failed to scan remote cloud tree:', err);
        }
    }

    async stop(): Promise<void> {
        this.logger.info('Stopping Proton Drive FUSE Engine...');
        this.unmountSync();
        this.logger.info('Proton Drive FUSE Engine stopped.');
    }

    // FodHooks & Dashboard Active Transfer implementation
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

    async hydrateFile(nodeUid: string, relativePath: string): Promise<string> {
        return await this.hydrator.hydrateNode(nodeUid, relativePath);
    }

    getUploads(): any[] {
        return this.fuseDriver ? this.fuseDriver.getActiveUploads() : [];
    }

    getActiveTransfers(): ActiveTransferInfo[] {
        const downloads = this.hydrator.getActiveTransfers();
        const uploads = this.getUploads();
        return [...downloads, ...uploads];
    }
}
