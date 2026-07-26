import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { exec, spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SyncDatabase } from '../sync/db';
import { FodHydrator } from './hydrator';
import { FodHooks } from '../sync/dashboard';

export class ProtonFuseEngine extends EventEmitter implements FodHooks {
    public isFuseMode: boolean = true;
    public mountPoint: string;
    private fuseProcess: ChildProcess | null = null;
    private hydrator: FodHydrator;
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
            if (this.fuseProcess) {
                this.fuseProcess.kill('SIGTERM');
                this.fuseProcess = null;
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

        const candidatePaths = [
            path.join(process.cwd(), 'release', 'proton-fuse'),
            path.join(path.dirname(process.execPath), 'proton-fuse'),
            path.join(path.dirname(process.execPath), 'release', 'proton-fuse'),
            '/usr/local/bin/proton-fuse',
        ];
        const fuseBin = candidatePaths.find(p => existsSync(p)) || candidatePaths[0];
        const dbPath = path.join(process.env.HOME || '/tmp', '.config', 'proton-drive-sync', 'sync_state.db');
        const cacheDir = this.hydrator.getCacheDir();

        if (existsSync(fuseBin)) {
            this.logger.info(`Launching native FUSE binary: ${fuseBin} "${this.mountPoint}" "${dbPath}" "${cacheDir}"`);
            this.fuseProcess = spawn(fuseBin, [this.mountPoint, dbPath, cacheDir], {
                stdio: 'ignore',
                detached: true,
            });
            this.isMounted = true;
            this.logger.info(`Proton Drive FUSE filesystem mounted cleanly on ${this.mountPoint}`);
        } else {
            this.logger.warn(`Native FUSE binary not found at ${fuseBin}. Please run: gcc -O2 src/fod/proton-fuse.c -lfuse3 -lsqlite3 -lpthread -o release/proton-fuse`);
        }
    }

    async stop(): Promise<void> {
        this.logger.info('Stopping Proton Drive FUSE Engine...');
        this.unmountSync();
        this.logger.info('Proton Drive FUSE Engine stopped.');
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

    async hydrateFile(nodeUid: string, relativePath: string): Promise<string> {
        return await this.hydrator.hydrateNode(nodeUid, relativePath);
    }

    getUploads(): any[] {
        return this.activeUploadsList;
    }
}
