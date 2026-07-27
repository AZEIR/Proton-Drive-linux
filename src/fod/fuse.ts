import { mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { NodeType } from '@protontech/drive-sdk';
import { SyncDatabase } from '../sync/db';
import { FodHydrator, ActiveTransferInfo } from './hydrator';
import { FuseDriver } from './fuse-driver';
import { FodHooks } from '../sync/dashboard';
import { updateNetworkSocketLimits } from '../utils/httpAgent';

export class ProtonFuseEngine extends EventEmitter implements FodHooks {
    public isFuseMode: boolean = true;
    public mountPoint: string;
    private hydrator: FodHydrator;
    private fuseDriver: FuseDriver | null = null;
    private isMounted: boolean = false;
    private isPaused: boolean;
    private lastError: string = '';
    private scanPromise: Promise<void> | null = null;
    private scanAbortController: AbortController | null = null;

    constructor(
        private db: SyncDatabase,
        private sdk: any,
        private auth: any,
        private logger: any,
        mountPoint?: string,
        private clientUid: string = '',
    ) {
        super();
        const home = process.env.HOME || '/tmp';
        this.mountPoint =
            mountPoint ||
            process.env.PROTON_FUSE_MOUNT_POINT ||
            db.getFuseMountPoint() ||
            path.join(home, 'P-Drive-FUSE');
        this.hydrator = new FodHydrator(db, sdk, logger);
        this.isPaused = db.getConfig('is_sync_paused', '0') === '1';
        this.hydrator.setPaused(this.isPaused);

        const wifiSafeMode = db.getConfig('sync_wifi_safe_mode', '0') === '1';
        const dbConcurrency = parseInt(db.getConfig('sync_concurrency', '2'), 10);
        const concurrency = wifiSafeMode ? 1 : (!isNaN(dbConcurrency) && dbConcurrency > 0 ? dbConcurrency : 2);
        updateNetworkSocketLimits(wifiSafeMode ? 2 : Math.min(concurrency * 2, 6));

        // Forward hydration progress events for UI real-time SSE stream
        this.hydrator.on('progress', (info) => this.emit('transfersChanged', info));
        this.hydrator.on('start', (info) => this.emit('transfersChanged', info));
        this.hydrator.on('complete', (info) => this.emit('transfersChanged', info));

    }

    async start(): Promise<void> {
        this.logger.info(`Starting Proton Drive FUSE Mode on mount point: ${this.mountPoint}`);

        // Detach a stale or disconnected FUSE mount before touching the path.
        // Even mkdir({ recursive: true }) stats an existing target and returns
        // ENOTCONN when the previous daemon died with the mount attached.
        await this.unmountStaleMount();
        mkdirSync(this.mountPoint, { recursive: true });

        this.fuseDriver = new FuseDriver(
            this.mountPoint,
            this.db,
            this.hydrator,
            this.sdk,
            this.logger,
            { clientUid: this.clientUid },
        );
        this.fuseDriver.setPaused(this.isPaused);

        // Forward upload events from FUSE driver to UI
        this.fuseDriver.on('upload_start', (info) => this.emit('transfersChanged', info));
        this.fuseDriver.on('upload_progress', (info) => this.emit('transfersChanged', info));
        this.fuseDriver.on('upload_complete', (info) => this.emit('transfersChanged', info));

        try {
            await this.fuseDriver.mount();
            this.isMounted = true;
            this.logger.info(`Proton Drive FUSE filesystem mounted cleanly on ${this.mountPoint}`);
            this.db.log(
                'system',
                'system',
                'completed',
                `FUSE filesystem mounted at ${this.mountPoint}`,
            );
            this.fuseDriver.recoverFailedUploads();

            // Populate and reconcile cloud metadata after local writeback
            // recovery has marked cache-only changes as protected.
            if (this.shouldRefreshRemoteTree()) {
                void this.scanRemoteTree().catch((err) => {
                    this.logger.error('FUSE background remote scan error:', err);
                });
            } else {
                this.logger.info('FUSE Mode: Reusing recent metadata; remote events will apply newer changes.');
            }
        } catch (err: any) {
            this.logger.error(`Failed to mount native TypeScript FUSE filesystem: ${err?.message || err}`);
            throw err;
        }
    }

    private runUnmountCommand(command: string, args: string[]): Promise<boolean> {
        return new Promise((resolve) => {
            execFile(command, args, (error) => resolve(!error));
        });
    }

    private async unmountStaleMount(): Promise<void> {
        if (await this.runUnmountCommand('fusermount3', ['-u', '-z', this.mountPoint])) return;
        if (await this.runUnmountCommand('fusermount', ['-u', '-z', this.mountPoint])) return;
        await this.runUnmountCommand('umount', ['-l', this.mountPoint]);
    }

    private shouldRefreshRemoteTree(): boolean {
        if (this.db.getMappingCount() === 0) return true;
        let lastScanAt = Number(this.db.getConfig('fod_last_full_scan_at', '0'));
        if (!Number.isFinite(lastScanAt) || lastScanAt <= 0) {
            const priorScan = this.db.getRecentLogs(200).find(
                (log) =>
                    log.direction === 'system' &&
                    log.status === 'completed' &&
                    log.message.startsWith('FUSE Mode: Mapped '),
            );
            lastScanAt = priorScan?.timestamp ?? 0;
            if (lastScanAt > 0) this.db.setConfig('fod_last_full_scan_at', String(lastScanAt));
        }
        return Date.now() - lastScanAt >= 30 * 60 * 1000;
    }

    public scanRemoteTree(force = true): Promise<void> {
        if (!force && !this.shouldRefreshRemoteTree()) return Promise.resolve();
        if (this.scanPromise) return this.scanPromise;
        const controller = new AbortController();
        this.scanAbortController = controller;
        this.scanPromise = this.performRemoteTreeScan(controller.signal).finally(() => {
            this.scanPromise = null;
            if (this.scanAbortController === controller) this.scanAbortController = null;
        });
        return this.scanPromise;
    }

    private async performRemoteTreeScan(signal: AbortSignal): Promise<void> {
        if (this.isPaused) return;
        this.logger.info('FUSE Mode: Syncing remote cloud directory structure...');
        this.db.log(
            'system',
            'system',
            'syncing',
            `FUSE metadata scan started (${this.db.getMappingCount()} cached items).`,
        );
        try {
            const rootFolder = await this.sdk.getMyFilesRootFolder();
            if (signal.aborted) throw new DOMException('FUSE metadata scan cancelled', 'AbortError');
            const queue: { uid: string; relPath: string }[] = [{ uid: rootFolder.uid, relPath: '' }];
            let mappedCount = 0;
            let activeWorkers = 0;
            let lastProgressAt = Date.now();
            const seenPaths = new Set<string>();

            const processNode = (currentRelPath: string, node: any) => {
                if (signal.aborted) return;
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
                seenPaths.add(relPath);
                const now = Date.now();
                if (mappedCount % 250 === 0 || now - lastProgressAt >= 15_000) {
                    lastProgressAt = now;
                    this.db.log(
                        'system',
                        'system',
                        'syncing',
                        `FUSE metadata scan progress: ${mappedCount} items mapped, ${queue.length} folders queued.`,
                    );
                }
                // A pending FUSE upload represents newer cache-only user data.
                // Do not overwrite its local size/mtime while scanning the
                // older remote revision.
                if (!this.db.hasPendingFodUpload(relPath)) {
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
                }

                if (isDir) {
                    queue.push({ uid: node.uid, relPath });
                }
            };

            const configuredWorkers = Number(this.db.getConfig('sync_concurrency', '2'));
            const workerCount = Math.max(
                1,
                Math.min(10, Number.isFinite(configuredWorkers) ? configuredWorkers : 2),
            );
            const workers = Array.from({ length: workerCount }, async () => {
                while (!signal.aborted) {
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
                        for await (const uid of this.sdk.iterateFolderChildrenNodeUids(
                            current.uid,
                            undefined,
                            signal,
                        )) {
                            childrenUids.push(uid);
                        }

                        const chunkSize = 50;
                        for (let i = 0; i < childrenUids.length && !signal.aborted; i += chunkSize) {
                            const chunk = childrenUids.slice(i, i + chunkSize);
                            try {
                                for await (const node of this.sdk.iterateNodes(chunk, signal)) {
                                    processNode(current.relPath, node);
                                }
                            } catch (chunkError) {
                                if (signal.aborted) throw chunkError;
                                for (const singleUid of chunk) {
                                    if (signal.aborted) break;
                                    try {
                                        for await (const node of this.sdk.iterateNodes([singleUid], signal)) {
                                            processNode(current.relPath, node);
                                        }
                                    } catch (nodeError) {
                                        if (signal.aborted) throw nodeError;
                                    }
                                }
                            }
                        }
                    } catch (folderErr) {
                        if (signal.aborted) break;
                        this.logger.error(`Error scanning folder ${current.relPath}:`, folderErr);
                    } finally {
                        activeWorkers--;
                    }
                }
            });

            await Promise.all(workers);
            if (signal.aborted) throw new DOMException('FUSE metadata scan cancelled', 'AbortError');
            for (const mapping of this.db.getAllMappings()) {
                if (!seenPaths.has(mapping.local_path) && !this.db.hasPendingFodUpload(mapping.local_path)) {
                    this.db.deleteMapping(mapping.local_path);
                }
            }
            this.lastError = '';
            this.db.setConfig('fod_last_full_scan_at', String(Date.now()));
            this.logger.info(`FUSE Mode: Remote directory structure sync complete. Mapped ${mappedCount} items.`);
            this.db.log('system', 'system', 'completed', `FUSE Mode: Mapped ${mappedCount} cloud items.`);
        } catch (err: any) {
            if (signal.aborted || err?.name === 'AbortError') {
                this.logger.info('FUSE Mode: Metadata scan cancelled.');
                this.db.log('system', 'system', 'completed', 'FUSE metadata scan cancelled during shutdown.');
                return;
            }
            this.lastError = err?.message || String(err);
            this.logger.error('FUSE Mode: Failed to scan remote cloud tree:', err);
            this.db.log('system', 'system', 'failed', `FUSE metadata scan failed: ${this.lastError}`);
        }
    }

    async stop(): Promise<void> {
        this.logger.info('Stopping Proton Drive FUSE Engine...');
        this.scanAbortController?.abort();
        const activeScan = this.scanPromise;
        if (activeScan) {
            await Promise.race([
                activeScan.catch(() => {}),
                new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
            ]);
        }
        const driver = this.fuseDriver;
        this.fuseDriver = null;
        if (driver) await driver.unmount();
        else if (this.isMounted) await this.unmountStaleMount();
        this.isMounted = false;
        this.logger.info('Proton Drive FUSE Engine stopped.');
    }

    async pause(): Promise<void> {
        this.isPaused = true;
        this.db.setConfig('is_sync_paused', '1');
        this.hydrator.setPaused(true);
        this.fuseDriver?.setPaused(true);
        this.db.log('system', 'system', 'completed', 'FUSE transfers paused');
    }

    async resume(): Promise<void> {
        this.isPaused = false;
        this.db.setConfig('is_sync_paused', '0');
        this.hydrator.setPaused(false);
        this.fuseDriver?.setPaused(false);
        this.db.log('system', 'system', 'completed', 'FUSE transfers resumed');
        void this.scanRemoteTree(false);
    }

    getStatus(): 'paused' | 'syncing' | 'synced' | 'error' {
        if (this.isPaused) return 'paused';
        if (this.getActiveTransfers().length > 0 || this.scanPromise) return 'syncing';
        if (this.lastError || this.db.getPendingFodUploadCount() > 0 || !this.isMounted) return 'error';
        return 'synced';
    }

    getIsPaused(): boolean {
        return this.isPaused;
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
