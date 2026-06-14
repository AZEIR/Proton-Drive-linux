import { DriveEvent, DriveEventType, NodeEntity, NodeType, ProtonDriveClient } from '@protontech/drive-sdk';
import chokidar from 'chokidar';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { mkdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { getSha1 } from '../commands/fileSystem/digest';
import { SyncDatabase, SyncMapping } from './db';

export class SyncEngine extends EventEmitter {
    private db: SyncDatabase;
    private sdk: ProtonDriveClient;
    private auth: any;
    private logger: any;
    private localSyncRoot: string;
    private remoteRootUid: string = '';
    private isPaused: boolean = false;
    private isScanning: boolean = false;
    private isStarted: boolean = false;
    private ignoredLocalChanges: Set<string> = new Set();
    private watcher: any = null;
    private remoteSubscription: any = null;
    private activeTransfers: Map<string, { type: 'upload' | 'download'; size: number; transferred: number }> = new Map();
    private localScanCount: number = 0;
    private remoteScanCount: number = 0;
    private wasRootDeleted: boolean = false;
    private recentDeletions: { timestamp: number; path: string; nodeUid: string }[] = [];
    private bulkDeletionWarning: boolean = false;
    private isOffline: boolean = false;
    private checkConnectionInterval: any = null;
    private concurrencyLimit: number = 3;


    constructor(db: SyncDatabase, sdk: ProtonDriveClient, auth: any, logger: any) {
        super();
        this.db = db;
        this.sdk = sdk;
        this.auth = auth;
        this.logger = logger;

        // Load config
        const defaultPath = path.join(homedir(), 'P-Drive');
        this.localSyncRoot = path.resolve(this.db.getConfig('local_sync_path', defaultPath));
        this.isPaused = this.db.getConfig('is_sync_paused', '0') === '1';
    }

    getLocalSyncRoot(): string {
        return this.localSyncRoot;
    }

    async setLocalSyncRoot(newPath: string): Promise<void> {
        const resolvedPath = path.resolve(newPath);
        if (resolvedPath === this.localSyncRoot) return;

        this.db.log('system', 'system', 'syncing', `Changing sync folder to ${resolvedPath}`);
        
        // Stop current sync
        const wasRunning = this.isStarted;
        await this.stop();

        this.localSyncRoot = resolvedPath;
        this.db.setConfig('local_sync_path', resolvedPath);

        // Reset database mappings (since we changed sync folders)
        this.db.clearMappings();

        if (wasRunning) {
            await this.start();
        }
        this.emit('statusChanged');
    }

    getStatus(): string {
        if (!this.auth.isLoggedIn()) return 'auth_required';
        if (this.isOffline) return 'offline';
        if (this.bulkDeletionWarning) return 'bulk_deletion_warning';
        if (this.isPaused) return 'paused';
        if (this.isScanning) return 'scanning';
        if (this.activeTransfers.size > 0) return 'syncing';
        if (this.isStarted) return 'synced';
        return 'idle';
    }

    getActiveTransfers() {
        return Array.from(this.activeTransfers.entries()).map(([filePath, val]) => ({
            filePath,
            type: val.type,
            size: val.size,
            transferred: val.transferred,
            percent: val.size > 0 ? Math.round((val.transferred / val.size) * 100) : 0,
        }));
    }

    async syncOnce(): Promise<void> {
        if (!this.auth.isLoggedIn()) return;
        
        // Ensure local sync directory exists
        if (!existsSync(this.localSyncRoot)) {
            this.wasRootDeleted = true;
            mkdirSync(this.localSyncRoot, { recursive: true });
        } else {
            this.wasRootDeleted = false;
        }

        this.logger.info(`Running one-time Sync Engine run at ${this.localSyncRoot}`);
        this.db.log('system', 'system', 'syncing', `Running one-time sync pass at ${this.localSyncRoot}`);

        try {
            // Get Proton Drive remote root folder
            const rootFolder = await this.sdk.getMyFilesRootFolder();
            this.remoteRootUid = rootFolder.uid;

            // Perform full reconciliation
            await this.forceSync();
        } catch (error: any) {
            this.logger.error('One-time sync failed:', error);
            this.db.log('system', 'system', 'failed', `One-time sync failed: ${error.message || error}`);
            throw error;
        }
    }

    async start(): Promise<void> {
        if (this.watcher || !this.auth.isLoggedIn()) return; // Already started or not authenticated
        this.isStarted = true;
        this.isPaused = false;
        this.db.setConfig('is_sync_paused', '0');

        // Ensure local sync directory exists
        if (!existsSync(this.localSyncRoot)) {
            this.wasRootDeleted = true;
            mkdirSync(this.localSyncRoot, { recursive: true });
        } else {
            this.wasRootDeleted = false;
        }

        this.logger.info(`Starting Sync Engine at ${this.localSyncRoot}`);
        this.db.log('system', 'system', 'completed', `Sync engine started at ${this.localSyncRoot}`);

        try {
            // Get Proton Drive remote root folder
            const rootFolder = await this.sdk.getMyFilesRootFolder();
            this.remoteRootUid = rootFolder.uid;

            // Setup the local watcher immediately so we don't miss any offline changes/events
            this.setupWatcher();

            // Perform startup fast reconciliation in the background
            this.startupSync().catch((err) => {
                this.logger.error('Background startup sync failed:', err);
            });

            // Subscribe to remote events
            await this.subscribeToRemoteEvents(rootFolder.treeEventScopeId);
        } catch (error: any) {
            this.logger.error('Failed to start Sync Engine:', error);
            this.db.log('system', 'system', 'failed', `Start failed: ${error.message || error}`);
            this.emit('error', error);
            this.isStarted = false;
        }
        this.emit('statusChanged');
    }

    async stop(): Promise<void> {
        this.logger.info('Stopping Sync Engine');
        this.isStarted = false;
        
        if (this.checkConnectionInterval) {
            clearInterval(this.checkConnectionInterval);
            this.checkConnectionInterval = null;
        }
        this.isOffline = false;
        
        if (this.watcher) {
            await this.watcher.close();
            this.watcher = null;
        }

        if (this.remoteSubscription) {
            try {
                this.remoteSubscription.dispose();
            } catch (err) {
                this.logger.warn('Error disposing remote event subscription:', err);
            }
            this.remoteSubscription = null;
        }

        this.emit('statusChanged');
    }

    async pause(): Promise<void> {
        if (this.isPaused) return;
        this.isPaused = true;
        this.db.setConfig('is_sync_paused', '1');
        this.db.log('system', 'system', 'completed', 'Synchronization paused');
        await this.stop();
        this.emit('statusChanged');
    }

    async resume(): Promise<void> {
        if (!this.isPaused) return;
        this.isPaused = false;
        this.db.setConfig('is_sync_paused', '0');
        this.db.log('system', 'system', 'completed', 'Synchronization resumed');
        await this.start();
        this.emit('statusChanged');
    }

    async forceSync(): Promise<void> {
        if (this.isScanning) return;
        this.isScanning = true;
        this.emit('statusChanged');
        this.db.log('system', 'system', 'syncing', 'Starting full repository scan');
        this.localScanCount = 0;
        this.remoteScanCount = 0;

        try {
            this.logger.info('Scanning local directory...');
            this.db.log('system', 'system', 'syncing', 'Scanning local filesystem...');
            const localFiles = this.scanLocalDir(this.localSyncRoot);
            this.db.log('system', 'system', 'syncing', `Local scan complete. Discovered ${localFiles.size} items.`);
            
            this.logger.info('Scanning remote Proton directory...');
            this.db.log('system', 'system', 'syncing', 'Scanning remote cloud directory...');
            const remoteFiles = new Map<string, NodeEntity>();
            await this.scanRemoteDir(this.remoteRootUid, '', remoteFiles);
            this.db.log('system', 'system', 'syncing', `Remote scan complete. Discovered ${remoteFiles.size} items.`);

            this.logger.info('Reconciling differences...');
            this.db.log('system', 'system', 'syncing', 'Comparing files and applying synchronization rules...');
            await this.reconcile(localFiles, remoteFiles);
            
            this.db.log('system', 'system', 'completed', 'Full synchronization complete');
        } catch (error: any) {
            this.logger.error('Full sync reconciliation failed:', error);
            this.db.log('system', 'system', 'failed', `Full sync failed: ${error.message || error}`);
        } finally {
            this.isScanning = false;
            this.emit('statusChanged');
        }
    }

    // Fast startup reconciliation using local scan and event logs
    // Performs full scan and reconciliation on startup
    async startupSync(): Promise<void> {
        this.logger.info('Performing startup full repository scan and reconciliation.');
        await this.forceSync();
    }

    // Recursively scan local files
    private scanLocalDir(dir: string, relativePath: string = ''): Map<string, { size: number; mtime: number; isDir: boolean }> {
        const results = new Map<string, { size: number; mtime: number; isDir: boolean }>();
        const absoluteDir = path.join(dir, relativePath);
        
        if (!existsSync(absoluteDir)) return results;

        const entries = readdirSync(absoluteDir, { withFileTypes: true });
        for (const entry of entries) {
            const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
            const absPath = path.join(dir, relPath);
            
            try {
                const stat = statSync(absPath);
                const isDir = stat.isDirectory();
                
                results.set(relPath, {
                    size: isDir ? 0 : stat.size,
                    mtime: stat.mtimeMs,
                    isDir,
                });

                this.localScanCount++;
                if (this.localScanCount % 50 === 0) {
                    this.db.log('system', 'system', 'syncing', `Local scan: discovered ${this.localScanCount} files...`);
                }

                if (isDir) {
                    const subResults = this.scanLocalDir(dir, relPath);
                    for (const [subRel, subStat] of subResults) {
                        results.set(subRel, subStat);
                    }
                }
            } catch (err) {
                this.logger.warn(`Failed to stat local file ${relPath}:`, err);
            }
        }
        return results;
    }

    // Recursively scan remote Proton folder
    private async scanRemoteDir(folderUid: string, relativePath: string, result: Map<string, NodeEntity>): Promise<void> {
        const childrenUids: string[] = [];
        for await (const uid of this.sdk.iterateFolderChildrenNodeUids(folderUid)) {
            childrenUids.push(uid);
        }

        // Fetch children in chunks of 50 to optimize network calls
        const chunkSize = 50;
        for (let i = 0; i < childrenUids.length; i += chunkSize) {
            const chunk = childrenUids.slice(i, i + chunkSize);
            for await (const node of this.sdk.iterateNodes(chunk)) {
                if ('missingUid' in node) continue; // Skip missing nodes
                if (node.trashTime) continue; // Skip trashed nodes
                
                const name = node.name.ok ? node.name.value : 'degraded_name';
                const relPath = relativePath ? `${relativePath}/${name}` : name;
                
                result.set(relPath, node);
                this.remoteScanCount++;

                if (this.remoteScanCount % 20 === 0) {
                    this.db.log('system', 'system', 'syncing', `Remote scan: discovered ${this.remoteScanCount} cloud files...`);
                }

                if (node.type === NodeType.Folder) {
                    await this.scanRemoteDir(node.uid, relPath, result);
                }
            }
        }
    }

    // Two-way reconciliation algorithm
    private async reconcile(
        localFiles: Map<string, { size: number; mtime: number; isDir: boolean }>,
        remoteFiles: Map<string, NodeEntity>
    ): Promise<void> {
        // Pre-reconciliation check: Detect remote renames/moves of folders and files
        const remoteUidToPath = new Map<string, string>();
        for (const [relPath, node] of remoteFiles) {
            remoteUidToPath.set(node.uid, relPath);
        }

        const mappings = this.db.getAllMappings();
        for (const mapping of mappings) {
            if (remoteUidToPath.has(mapping.node_uid)) {
                const newRelPath = remoteUidToPath.get(mapping.node_uid)!;
                if (newRelPath !== mapping.local_path) {
                    const oldRelPath = mapping.local_path;
                    const oldLocalPath = this.resolveLocalPath(oldRelPath);
                    const newLocalPath = this.resolveLocalPath(newRelPath);

                    this.logger.info(`Detected remote rename/move of node ${mapping.node_uid} from ${oldRelPath} to ${newRelPath}`);
                    this.db.log(newRelPath, 'rename_local', 'completed', `Renaming local path from ${oldRelPath}`);

                    this.ignoredLocalChanges.add(oldLocalPath);
                    this.ignoredLocalChanges.add(newLocalPath);
                    try {
                        if (existsSync(oldLocalPath)) {
                            const parentDir = path.dirname(newLocalPath);
                            if (!existsSync(parentDir)) {
                                mkdirSync(parentDir, { recursive: true });
                            }
                            await rename(oldLocalPath, newLocalPath);
                        }
                    } catch (err) {
                        this.logger.error(`Failed to rename local path from ${oldRelPath} to ${newRelPath}:`, err);
                    } finally {
                        this.ignoredLocalChanges.delete(oldLocalPath);
                        this.ignoredLocalChanges.delete(newLocalPath);
                    }

                    // Update parent mapping in database
                    this.db.deleteMapping(oldRelPath);
                    this.db.setMapping({
                        ...mapping,
                        local_path: newRelPath
                    });

                    // Update parent key in localFiles map
                    const parentLocal = localFiles.get(oldRelPath);
                    if (parentLocal) {
                        localFiles.delete(oldRelPath);
                        localFiles.set(newRelPath, parentLocal);
                    }

                    // If it is a directory, update child mappings in DB and rename keys in localFiles
                    if (mapping.is_dir === 1) {
                        const allMappings = this.db.getAllMappings();
                        for (const m of allMappings) {
                            if (m.local_path.startsWith(`${oldRelPath}/`)) {
                                const suffix = m.local_path.slice(oldRelPath.length);
                                const newChildPath = `${newRelPath}${suffix}`;

                                this.db.deleteMapping(m.local_path);
                                this.db.setMapping({
                                    ...m,
                                    local_path: newChildPath
                                });

                                const childLocal = localFiles.get(m.local_path);
                                if (childLocal) {
                                    localFiles.delete(m.local_path);
                                    localFiles.set(newChildPath, childLocal);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Local rename/move detection
        const mappingsAfterRemote = this.db.getAllMappings();
        const localDeletes = mappingsAfterRemote.filter(m => !localFiles.has(m.local_path));
        const localAdds = Array.from(localFiles.keys()).filter(p => !this.db.getMapping(p) && !remoteFiles.has(p));

        // 1. Match directory renames/moves first (to optimize nested transfers)
        const delDirs = localDeletes.filter(m => m.is_dir === 1);
        const addDirs = localAdds.filter(p => localFiles.get(p)?.isDir === true);

        for (const addPath of [...addDirs]) {
            const addInfo = localFiles.get(addPath)!;
            
            const addChildren = Array.from(localFiles.entries())
                .filter(([p, info]) => path.dirname(p) === addPath)
                .map(([p, info]) => ({ name: path.basename(p), size: info.size, isDir: info.isDir }));

            for (const matchedDel of [...delDirs]) {
                const delChildren = mappingsAfterRemote
                    .filter(m => path.dirname(m.local_path) === matchedDel.local_path)
                    .map(m => ({ name: path.basename(m.local_path), size: m.size, isDir: m.is_dir === 1 }));

                if (addChildren.length !== delChildren.length) continue;

                let match = true;
                for (const ac of addChildren) {
                    const dc = delChildren.find(d => d.name === ac.name && d.size === ac.size && d.isDir === ac.isDir);
                    if (!dc) {
                        match = false;
                        break;
                    }
                }

                if (match) {
                    this.logger.info(`Detected local directory rename/move of node ${matchedDel.node_uid} from ${matchedDel.local_path} to ${addPath}`);
                    this.db.log(addPath, 'rename_remote', 'syncing', `Renaming remote folder from ${matchedDel.local_path}`);

                    // A. Handle move
                    const oldParent = path.dirname(matchedDel.local_path);
                    const newParent = path.dirname(addPath);
                    if (oldParent !== newParent) {
                        const newParentUid = newParent === '.' ? this.remoteRootUid : await this.ensureRemoteParentFolder(newParent);
                        await this.runWithRetry(async () => {
                            for await (const result of this.sdk.moveNodes([matchedDel.node_uid], newParentUid)) {
                                if (!result.ok) throw result.error;
                            }
                        });
                    }

                    // B. Handle rename
                    const oldName = path.basename(matchedDel.local_path);
                    const newName = path.basename(addPath);
                    if (oldName !== newName) {
                        await this.runWithRetry(async () => {
                            await this.sdk.renameNode(matchedDel.node_uid, newName);
                        });
                    }

                    // C. Update DB mappings of parent and children
                    this.db.deleteMapping(matchedDel.local_path);
                    this.db.setMapping({
                        ...matchedDel,
                        local_path: addPath,
                        mtime: addInfo.mtime
                    });

                    const oldPrefix = matchedDel.local_path;
                    const newPrefix = addPath;

                    const allMappings = this.db.getAllMappings();
                    for (const m of allMappings) {
                        if (m.local_path.startsWith(`${oldPrefix}/`)) {
                            const suffix = m.local_path.slice(oldPrefix.length);
                            const newChildPath = `${newPrefix}${suffix}`;

                            this.db.deleteMapping(m.local_path);
                            this.db.setMapping({
                                ...m,
                                local_path: newChildPath
                            });

                            const childLocal = localFiles.get(m.local_path);
                            if (childLocal) {
                                localFiles.delete(m.local_path);
                                localFiles.set(newChildPath, childLocal);
                            }

                            const addIdx = localAdds.indexOf(m.local_path);
                            if (addIdx !== -1) localAdds.splice(addIdx, 1);

                            const delIdx = localDeletes.findIndex(d => d.local_path === m.local_path);
                            if (delIdx !== -1) localDeletes.splice(delIdx, 1);
                        }
                    }

                    const parentLocal = localFiles.get(matchedDel.local_path);
                    if (parentLocal) {
                        localFiles.delete(matchedDel.local_path);
                        localFiles.set(addPath, parentLocal);
                    }

                    localAdds.splice(localAdds.indexOf(addPath), 1);
                    localDeletes.splice(localDeletes.indexOf(matchedDel), 1);
                    delDirs.splice(delDirs.indexOf(matchedDel), 1);

                    this.db.log(addPath, 'rename_remote', 'completed', `Renamed remote folder successfully`);
                    break;
                }
            }
        }

        // 2. Match file renames/moves
        for (const addPath of [...localAdds]) {
            const addInfo = localFiles.get(addPath)!;
            if (addInfo.isDir) continue;

            const candidates = localDeletes.filter(m => m.is_dir === 0 && m.size === addInfo.size);
            if (candidates.length === 0) continue;

            try {
                const addSha1 = await getSha1(this.resolveLocalPath(addPath));
                const matched = candidates.find(m => m.sha1 === addSha1);
                if (matched) {
                    this.logger.info(`Detected local file rename/move of node ${matched.node_uid} from ${matched.local_path} to ${addPath}`);
                    this.db.log(addPath, 'rename_remote', 'syncing', `Renaming remote file from ${matched.local_path}`);

                    // A. Handle move
                    const oldParent = path.dirname(matched.local_path);
                    const newParent = path.dirname(addPath);
                    if (oldParent !== newParent) {
                        const newParentUid = newParent === '.' ? this.remoteRootUid : await this.ensureRemoteParentFolder(newParent);
                        await this.runWithRetry(async () => {
                            for await (const result of this.sdk.moveNodes([matched.node_uid], newParentUid)) {
                                if (!result.ok) throw result.error;
                            }
                        });
                    }

                    // B. Handle rename
                    const oldName = path.basename(matched.local_path);
                    const newName = path.basename(addPath);
                    if (oldName !== newName) {
                        await this.runWithRetry(async () => {
                            await this.sdk.renameNode(matched.node_uid, newName);
                        });
                    }

                    // C. Update DB mapping
                    this.db.deleteMapping(matched.local_path);
                    this.db.setMapping({
                        ...matched,
                        local_path: addPath,
                        sha1: addSha1,
                        mtime: addInfo.mtime
                    });

                    localAdds.splice(localAdds.indexOf(addPath), 1);
                    localDeletes.splice(localDeletes.indexOf(matched), 1);
                    this.db.log(addPath, 'rename_remote', 'completed', `Renamed remote file successfully`);
                }
            } catch (err) {
                this.logger.error(`Error during local rename detection for ${addPath}:`, err);
            }
        }

        const allPaths = new Set([...localFiles.keys(), ...remoteFiles.keys()]);
        
        const directoryPaths: string[] = [];
        const filePaths: string[] = [];
        
        for (const relPath of allPaths) {
            const local = localFiles.get(relPath);
            const remote = remoteFiles.get(relPath);
            const mapped = this.db.getMapping(relPath);
            const isDir = (local && local.isDir) || (remote && remote.type === NodeType.Folder) || (mapped && mapped.is_dir);
            
            if (isDir) {
                directoryPaths.push(relPath);
            } else {
                filePaths.push(relPath);
            }
        }

        // 1. Process directories sequentially, sorted by depth (shallowest first)
        // This ensures parent directories exist before any files are processed/reconciled.
        directoryPaths.sort((a, b) => a.split('/').length - b.split('/').length);
        this.logger.info(`Reconciling ${directoryPaths.length} directories sequentially...`);
        for (const relPath of directoryPaths) {
            await this.reconcilePath(relPath, localFiles.get(relPath), remoteFiles.get(relPath), this.db.getMapping(relPath));
        }

        // 2. Process file operations in parallel with a concurrency limit
        this.logger.info(`Reconciling ${filePaths.length} files in parallel (concurrency limit = ${this.concurrencyLimit})...`);
        const queue = [...filePaths];
        const workers = Array.from({ length: Math.min(this.concurrencyLimit, queue.length) }, async () => {
            while (queue.length > 0) {
                const relPath = queue.shift();
                if (relPath !== undefined) {
                    await this.reconcilePath(relPath, localFiles.get(relPath), remoteFiles.get(relPath), this.db.getMapping(relPath));
                }
            }
        });
        await Promise.all(workers);

        // Clean up database mapping entries for things that no longer exist on either side
        const allMappings = this.db.getAllMappings();
        for (const mapping of allMappings) {
            if (!localFiles.has(mapping.local_path) && !remoteFiles.has(mapping.local_path)) {
                this.db.deleteMapping(mapping.local_path);
            }
        }
    }

    private async reconcilePath(
        relPath: string,
        local: { size: number; mtime: number; isDir: boolean } | undefined,
        remote: NodeEntity | undefined,
        mapped: SyncMapping | undefined
    ): Promise<void> {
        try {
            if (local && remote) {
                // Item exists both locally and remotely
                if (!mapped) {
                    // Conflict or fresh setup merge: compare modification times
                    const remoteMtime = remote.activeRevision?.ok && remote.activeRevision.value.claimedModificationTime
                        ? new Date(remote.activeRevision.value.claimedModificationTime).getTime()
                        : remote.modificationTime.getTime();

                    if (Math.abs(local.mtime - remoteMtime) < 2000) {
                        // Times match closely, assume synced
                        this.db.setMapping({
                            local_path: relPath,
                            node_uid: remote.uid,
                            is_dir: remote.type === NodeType.Folder ? 1 : 0,
                            size: local.size,
                            mtime: local.mtime,
                            sha1: remote.type === NodeType.Folder ? '' : await getSha1(this.resolveLocalPath(relPath)),
                            remote_revision_uid: remote.activeRevision?.ok ? remote.activeRevision.value.uid : '',
                            remote_mtime: remoteMtime,
                        });
                    } else if (local.mtime > remoteMtime) {
                        // Local is newer: upload
                        await this.syncLocalToRemote(relPath, local.isDir);
                    } else {
                        // Remote is newer: download
                        await this.syncRemoteToLocal(relPath, remote);
                    }
                } else {
                    // We have a database mapping. Check if changed.
                    const localChanged = local.size !== mapped.size || Math.abs(local.mtime - mapped.mtime) > 2000;
                    
                    const remoteRevUid = remote.activeRevision?.ok ? remote.activeRevision.value.uid : '';
                    const remoteChanged = remoteRevUid !== mapped.remote_revision_uid;

                    if (localChanged && remoteChanged) {
                        // Conflict! Both sides updated independently
                        await this.handleConflict(relPath, remote);
                    } else if (localChanged) {
                        // Upload local change
                        await this.syncLocalToRemote(relPath, local.isDir);
                    } else if (remoteChanged) {
                        // Download remote change
                        await this.syncRemoteToLocal(relPath, remote);
                    }
                }
            } else if (local && !remote) {
                // Exists locally but not remotely
                if (!mapped) {
                    // New local file
                    await this.syncLocalToRemote(relPath, local.isDir);
                } else {
                    // Previously mapped: was deleted remotely
                    this.logger.info(`Deleting local file (remote deletion): ${relPath}`);
                    await this.deleteLocalFile(relPath);
                }
            } else if (!local && remote) {
                // Exists remotely but not locally
                if (!mapped) {
                    // New remote file
                    await this.syncRemoteToLocal(relPath, remote);
                } else {
                    // Previously mapped: was deleted locally
                    this.logger.info(`Trashing remote node (local deletion): ${relPath}`);
                    await this.deleteRemoteNode(remote.uid, relPath);
                }
            }
        } catch (err: any) {
            this.logger.error(`Error reconciling path ${relPath}:`, err);
            this.db.log(relPath, 'system', 'failed', `Reconciliation error: ${err.message || err}`);
        }
    }

    // Local file watcher logic using chokidar
    private setupWatcher() {
        if (this.watcher) return;

        this.watcher = chokidar.watch(this.localSyncRoot, {
            ignored: /(^|[\/\\])\../, // ignore dotfiles
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 1000,
                pollInterval: 100,
            },
        });

        this.watcher
            .on('add', (filePath: string) => this.handleLocalChange(filePath, 'add', false))
            .on('change', (filePath: string) => this.handleLocalChange(filePath, 'change', false))
            .on('unlink', (filePath: string) => this.handleLocalChange(filePath, 'unlink', false))
            .on('addDir', (dirPath: string) => this.handleLocalChange(dirPath, 'add', true))
            .on('unlinkDir', (dirPath: string) => this.handleLocalChange(dirPath, 'unlink', true));
    }

    private async handleLocalChange(absolutePath: string, type: 'add' | 'change' | 'unlink', isDir: boolean) {
        if (this.isPaused) return;

        // Safety guard: if the local sync root directory itself was deleted or does not exist,
        // do NOT propagate deletions to the remote. This prevents accidental deletion of remote files.
        if (!existsSync(this.localSyncRoot)) {
            this.logger.warn(`Local sync root folder ${this.localSyncRoot} was deleted or is missing! Ignoring watcher changes.`);
            this.db.log('system', 'system', 'failed', `Local sync folder ${this.localSyncRoot} is missing. Halting updates and triggering restore.`);
            
            // Recreate local sync root safely
            mkdirSync(this.localSyncRoot, { recursive: true });
            this.wasRootDeleted = true;
            
            // Trigger a rebuild and restoration of files
            this.startupSync();
            return;
        }

        const relativePath = path.relative(this.localSyncRoot, absolutePath);
        
        // Skip changes triggered by downloading files
        if (this.ignoredLocalChanges.has(absolutePath)) {
            this.logger.debug(`Ignoring self-triggered change at ${relativePath}`);
            return;
        }

        this.logger.info(`Watcher local change: [${type}] ${relativePath} (isDir=${isDir})`);

        try {
            if (type === 'add' || type === 'change') {
                await this.syncLocalToRemote(relativePath, isDir);
            } else if (type === 'unlink') {
                const mapped = this.db.getMapping(relativePath);
                if (mapped) {
                    // Check 1: Empty folder safeguard (if local folder is emptied but database has active mappings)
                    let isEmptyWipe = false;
                    try {
                        const localFilesCount = this.countLocalFiles(this.localSyncRoot);
                        const mappedCount = this.db.getAllMappings().length;
                        if (localFilesCount <= 1 && mappedCount > 5) {
                            isEmptyWipe = true;
                        }
                    } catch (err) {}

                    // Check 2: Sliding window rate limit (10 deletions in 15 seconds)
                    this.recentDeletions.push({ timestamp: Date.now(), path: relativePath, nodeUid: mapped.node_uid });
                    this.recentDeletions = this.recentDeletions.filter(d => Date.now() - d.timestamp < 15000);

                    if (isEmptyWipe || this.recentDeletions.length >= 10) {
                        this.logger.warn(`Bulk deletion safety warning triggered! isEmptyWipe=${isEmptyWipe}, deletionsCount=${this.recentDeletions.length}`);
                        this.bulkDeletionWarning = true;
                        await this.pause();
                        
                        const msg = isEmptyWipe 
                            ? "Local sync folder was emptied. Synchronization paused to protect remote cloud files."
                            : `Bulk deletion of ${this.recentDeletions.length} files detected. Synchronization paused.`;
                        
                        this.db.log('system', 'system', 'failed', msg);
                        this.emit('statusChanged');
                        return;
                    }

                    await this.deleteRemoteNode(mapped.node_uid, relativePath);
                }
            }
            this.emit('statusChanged');
        } catch (err: any) {
            this.logger.error(`Failed to handle local change at ${relativePath}:`, err);
            this.db.log(relativePath, 'system', 'failed', `Watcher error: ${err.message || err}`);
        }
    }

    // Subscribe to remote events
    private async subscribeToRemoteEvents(scopeId: string) {
        if (this.remoteSubscription) return;

        this.logger.info(`Subscribing to remote events for scope ${scopeId}`);

        this.remoteSubscription = await this.sdk.subscribeToTreeEvents(scopeId, async (event: DriveEvent) => {
            if (this.isPaused) return;

            try {
                this.logger.info(`Received remote event type: ${event.type}`);
                await this.handleRemoteEvent(event);
                this.emit('statusChanged');
            } catch (err: any) {
                this.logger.error('Failed to handle remote event:', err);
            }
        });
    }

    private async handleRemoteEvent(event: DriveEvent) {
        // Skip if event type is shared updates or fastforwards that don't edit files
        if (
            event.type === DriveEventType.SharedWithMeUpdated ||
            event.type === DriveEventType.FastForward ||
            event.type === DriveEventType.TreeRefresh ||
            event.type === DriveEventType.TreeRemove
        ) {
            return;
        }

        const nodeUid = event.nodeUid;

        if (event.type === DriveEventType.NodeDeleted) {
            const mapped = this.db.getMappingByNodeUid(nodeUid);
            if (mapped) {
                this.logger.info(`Remote node deleted, deleting local path: ${mapped.local_path}`);
                await this.deleteLocalFile(mapped.local_path);
            }
            return;
        }

        // Fetch node from server/cache
        const node = await this.sdk.getNode(nodeUid);

        // Check if trashed/deleted
        if (node.trashTime || event.isTrashed) {
            const mapped = this.db.getMappingByNodeUid(nodeUid);
            if (mapped) {
                this.logger.info(`Remote node trashed, deleting local path: ${mapped.local_path}`);
                await this.deleteLocalFile(mapped.local_path);
            }
            return;
        }

        // Get hierarchy of the node to see if it is inside our sync tree
        const hierarchy = await this.sdk.getNodeHierarchy(nodeUid);
        if (hierarchy.length === 0 || hierarchy[0].uid !== this.remoteRootUid) {
            // Node is outside our sync root
            return;
        }

        // Build relative path
        const relativePath = hierarchy
            .slice(1)
            .map((n) => (n.name.ok ? n.name.value : ''))
            .join('/');

        if (!relativePath) return;

        // Process remote created or updated event
        await this.syncRemoteToLocal(relativePath, node);
    }

    // Synchronization operations: Sync Local -> Remote
    private async syncLocalToRemote(relativePath: string, isDir: boolean): Promise<void> {
        const localPath = this.resolveLocalPath(relativePath);
        if (!existsSync(localPath)) return;

        this.activeTransfers.set(relativePath, { type: 'upload', size: 0, transferred: 0 });
        this.emit('statusChanged');
        this.db.log(relativePath, 'upload', 'syncing', 'Uploading local file/folder');

        try {
            if (isDir) {
                await this.runWithRetry(async () => {
                    const stat = statSync(localPath);
                    
                    // Ensure parent exists remotely and get its UID
                    const parts = relativePath.split('/');
                    const folderName = parts.pop()!;
                    const parentRelPath = parts.join('/');
                    const parentUid = parentRelPath ? await this.ensureRemoteParentFolder(parentRelPath) : this.remoteRootUid;

                    // Create directory remotely
                    let nodeUid = '';
                    try {
                        const node = await this.sdk.createFolder(parentUid, folderName);
                        nodeUid = node.uid;
                    } catch (err: any) {
                        // If directory already exists, grab its UID
                        if (err.existingNodeUid) {
                            nodeUid = err.existingNodeUid;
                        } else {
                            throw err;
                        }
                    }

                    this.db.setMapping({
                        local_path: relativePath,
                        node_uid: nodeUid,
                        is_dir: 1,
                        size: 0,
                        mtime: stat.mtimeMs,
                        sha1: '',
                        remote_revision_uid: '',
                        remote_mtime: stat.mtimeMs,
                    });
                    
                    this.db.log(relativePath, 'upload', 'completed', 'Local folder mapped to remote');
                });
            } else {
                // It is a file upload
                const stat = statSync(localPath);
                const size = stat.size;
                const mtime = stat.mtimeMs;
                const sha1 = await getSha1(localPath);

                const file = Bun.file(localPath);
                const metadata = {
                    mediaType: file.type || 'application/octet-stream',
                    expectedSize: size,
                    expectedSha1: sha1,
                    modificationTime: new Date(mtime),
                };

                const mapped = this.db.getMapping(relativePath);

                // Set file upload details
                this.activeTransfers.set(relativePath, { type: 'upload', size, transferred: 0 });
                this.emit('statusChanged');

                const progressCallback = (uploadedBytes: number) => {
                    const transfer = this.activeTransfers.get(relativePath);
                    if (transfer) {
                        transfer.transferred = uploadedBytes;
                        this.emit('statusChanged');
                    }
                };

                const { nodeUid, nodeRevisionUid } = await this.runWithRetry(async () => {
                    let uploadController;
                    if (mapped) {
                        this.logger.info(`Uploading file revision for ${relativePath} (${mapped.node_uid})`);
                        const uploader = await this.sdk.getFileRevisionUploader(mapped.node_uid, metadata);
                        uploadController = await uploader.uploadFromStream(file.stream(), [], progressCallback);
                    } else {
                        // Upload new file: ensure remote parent directory exists first
                        const parts = relativePath.split('/');
                        const fileName = parts.pop()!;
                        const parentRelPath = parts.join('/');
                        const parentUid = parentRelPath ? await this.ensureRemoteParentFolder(parentRelPath) : this.remoteRootUid;

                        this.logger.info(`Uploading new file ${fileName} under parent ${parentUid}`);
                        const uploader = await this.sdk.getFileUploader(parentUid, fileName, metadata);
                        uploadController = await uploader.uploadFromStream(file.stream(), [], progressCallback);
                    }

                    return await uploadController.completion();
                });

                // Verify if it was deleted locally during the upload
                if (!existsSync(localPath)) {
                    this.logger.warn(`File ${relativePath} was deleted locally during upload. Trashing remote node.`);
                    await this.deleteRemoteNode(nodeUid, relativePath);
                    return;
                }

                // Save mapping
                this.db.setMapping({
                    local_path: relativePath,
                    node_uid: nodeUid,
                    is_dir: 0,
                    size,
                    mtime,
                    sha1,
                    remote_revision_uid: nodeRevisionUid,
                    remote_mtime: mtime,
                });

                this.db.log(relativePath, 'upload', 'completed', 'Uploaded successfully');
            }
        } catch (err: any) {
            this.logger.error(`Upload failed for ${relativePath}:`, err);
            this.db.log(relativePath, 'upload', 'failed', `Upload error: ${err.message || err}`);
            throw err;
        } finally {
            this.activeTransfers.delete(relativePath);
            this.emit('statusChanged');
        }
    }

    // Synchronization operations: Sync Remote -> Local
    private async syncRemoteToLocal(relativePath: string, node: NodeEntity): Promise<void> {
        const localPath = this.resolveLocalPath(relativePath);

        // Pre-download check: Detect remote rename/move of folders and files
        const mappedByUid = this.db.getMappingByNodeUid(node.uid);
        if (mappedByUid && mappedByUid.local_path !== relativePath) {
            const oldRelPath = mappedByUid.local_path;
            const oldLocalPath = this.resolveLocalPath(oldRelPath);
            
            this.logger.info(`Detected remote rename/move of node ${node.uid} from ${oldRelPath} to ${relativePath}`);
            this.db.log(relativePath, 'rename_local', 'completed', `Renaming local path from ${oldRelPath}`);

            this.ignoredLocalChanges.add(oldLocalPath);
            this.ignoredLocalChanges.add(localPath);
            try {
                if (existsSync(oldLocalPath)) {
                    const parentDir = path.dirname(localPath);
                    if (!existsSync(parentDir)) {
                        mkdirSync(parentDir, { recursive: true });
                    }
                    await rename(oldLocalPath, localPath);
                }
            } catch (err) {
                this.logger.error(`Failed to rename local path from ${oldRelPath} to ${localPath}:`, err);
            } finally {
                this.ignoredLocalChanges.delete(oldLocalPath);
                this.ignoredLocalChanges.delete(localPath);
            }

            // Update database mappings for parent folder/file
            this.db.deleteMapping(oldRelPath);
            this.db.setMapping({
                ...mappedByUid,
                local_path: relativePath
            });

            // If it is a directory, update child mappings in DB
            if (mappedByUid.is_dir === 1) {
                const allMappings = this.db.getAllMappings();
                for (const m of allMappings) {
                    if (m.local_path.startsWith(`${oldRelPath}/`)) {
                        const suffix = m.local_path.slice(oldRelPath.length);
                        const newChildPath = `${relativePath}${suffix}`;
                        
                        this.db.deleteMapping(m.local_path);
                        this.db.setMapping({
                            ...m,
                            local_path: newChildPath
                        });
                    }
                }
            }
        }

        // Guard: Skip downloading if our database mapping matches this exact remote revision
        if (node.type !== NodeType.Folder) {
            const revision = node.activeRevision?.ok ? node.activeRevision.value : null;
            const mapped = this.db.getMapping(relativePath);
            if (revision && mapped && mapped.remote_revision_uid === revision.uid) {
                this.logger.debug(`Skipping download for ${relativePath} - already at remote revision ${revision.uid}`);
                return;
            }
        }

        this.activeTransfers.set(relativePath, { type: 'download', size: 0, transferred: 0 });
        this.emit('statusChanged');
        this.db.log(relativePath, 'download', 'syncing', 'Downloading remote file/folder');

        try {
            if (node.type === NodeType.Folder) {
                await this.runWithRetry(async () => {
                    // Ensure directory exists locally
                    this.ignoredLocalChanges.add(localPath);
                    if (!existsSync(localPath)) {
                        mkdirSync(localPath, { recursive: true });
                    }
                    this.ignoredLocalChanges.delete(localPath);

                    const remoteMtime = node.folder?.claimedModificationTime
                        ? new Date(node.folder.claimedModificationTime).getTime()
                        : node.modificationTime.getTime();

                    this.db.setMapping({
                        local_path: relativePath,
                        node_uid: node.uid,
                        is_dir: 1,
                        size: 0,
                        mtime: remoteMtime,
                        sha1: '',
                        remote_revision_uid: '',
                        remote_mtime: remoteMtime,
                    });
                    
                    this.db.log(relativePath, 'download', 'completed', 'Remote folder mapped to local directory');
                });
            } else {
                // Download file
                const revision = node.activeRevision?.ok ? node.activeRevision.value : null;
                if (!revision) {
                    throw new Error('Remote file has no active revision');
                }

                // Check if directory containing file exists locally
                const parentLocalPath = path.dirname(localPath);
                this.ignoredLocalChanges.add(parentLocalPath);
                if (!existsSync(parentLocalPath)) {
                    mkdirSync(parentLocalPath, { recursive: true });
                }
                this.ignoredLocalChanges.delete(parentLocalPath);

                const tmpPath = `${localPath}.tmp-${Date.now()}`;
                
                this.ignoredLocalChanges.add(tmpPath);
                const bunFile = Bun.file(tmpPath);
                const writer = bunFile.writer();
                const writableStream = {
                    getWriter: () => writer,
                    close: async () => { await writer.end(); },
                    abort: async () => { await writer.end(); await unlink(tmpPath).catch(() => {}); },
                    locked: false,
                };

                const size = revision.claimedSize ?? 0;
                this.activeTransfers.set(relativePath, { type: 'download', size, transferred: 0 });
                this.emit('statusChanged');

                const progressCallback = (downloadedBytes: number) => {
                    const transfer = this.activeTransfers.get(relativePath);
                    if (transfer) {
                        transfer.transferred = downloadedBytes;
                        this.emit('statusChanged');
                    }
                };

                try {
                    await this.runWithRetry(async () => {
                        const downloader = await this.sdk.getFileDownloader(node);
                        const downloadController = downloader.downloadToStream(writableStream as any, progressCallback);
                        await downloadController.completion();
                    });
                    await writer.end();
                } catch (downloadErr) {
                    await writableStream.abort();
                    throw downloadErr;
                } finally {
                    this.ignoredLocalChanges.delete(tmpPath);
                }

                // Rename temporary file to final path
                this.ignoredLocalChanges.add(localPath);
                if (existsSync(localPath)) {
                    await unlink(localPath);
                }
                await mkdir(path.dirname(localPath), { recursive: true }).catch(() => {});
                await Bun.write(localPath, Bun.file(tmpPath));
                await unlink(tmpPath);

                // Set modification time locally to match remote
                const remoteMtime = revision.claimedModificationTime
                    ? new Date(revision.claimedModificationTime).getTime()
                    : revision.creationTime.getTime();
                
                utimesSync(localPath, new Date(), new Date(remoteMtime));
                this.ignoredLocalChanges.delete(localPath);

                // Fetch local stat to verify size/mtime mapping
                const localStat = statSync(localPath);

                // Save mapping
                this.db.setMapping({
                    local_path: relativePath,
                    node_uid: node.uid,
                    is_dir: 0,
                    size: localStat.size,
                    mtime: localStat.mtimeMs,
                    sha1: revision.claimedDigests?.sha1 || '',
                    remote_revision_uid: revision.uid,
                    remote_mtime: remoteMtime,
                });

                this.db.log(relativePath, 'download', 'completed', 'Downloaded successfully');
            }
        } catch (err: any) {
            this.logger.error(`Download failed for ${relativePath}:`, err);
            this.db.log(relativePath, 'download', 'failed', `Download error: ${err.message || err}`);
            throw err;
        } finally {
            this.activeTransfers.delete(relativePath);
            this.emit('statusChanged');
        }
    }

    // Handles conflicts by downloading the remote as primary and renaming local version
    private async handleConflict(relativePath: string, node: NodeEntity) {
        const localPath = this.resolveLocalPath(relativePath);
        if (!existsSync(localPath)) return;

        const ext = path.extname(relativePath);
        const stem = path.basename(relativePath, ext);
        const parentDir = path.dirname(relativePath);
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const conflictRelPath = parentDir === '.'
            ? `${stem} (Conflict ${timestamp})${ext}`
            : `${parentDir}/${stem} (Conflict ${timestamp})${ext}`;

        const conflictAbsPath = this.resolveLocalPath(conflictRelPath);
        
        this.logger.warn(`Conflict detected at ${relativePath}. Renaming local to ${conflictRelPath}`);
        this.db.log(relativePath, 'system', 'syncing', `Conflict detected. Renaming local to: ${path.basename(conflictRelPath)}`);

        // Rename local file to conflict path
        this.ignoredLocalChanges.add(localPath);
        this.ignoredLocalChanges.add(conflictAbsPath);
        await Bun.write(conflictAbsPath, Bun.file(localPath));
        await unlink(localPath);
        this.ignoredLocalChanges.delete(localPath);
        this.ignoredLocalChanges.delete(conflictAbsPath);

        // Upload the renamed conflict copy as a new file
        await this.syncLocalToRemote(conflictRelPath, false);

        // Download the remote file to the original path
        await this.syncRemoteToLocal(relativePath, node);
    }

    // Helper: ensuring remote folders exist along a path
    private async ensureRemoteParentFolder(parentRelativePath: string): Promise<string> {
        return await this.runWithRetry(async () => {
            const parts = parentRelativePath.split('/');
            let currentParentUid = this.remoteRootUid;
            let prefix = '';

            for (const part of parts) {
                prefix = prefix ? `${prefix}/${part}` : part;
                const mapped = this.db.getMapping(prefix);
                
                if (mapped) {
                    currentParentUid = mapped.node_uid;
                } else {
                    // Check if directory already exists remotely but isn't mapped yet
                    let foundUid = '';
                    for await (const childUid of this.sdk.iterateFolderChildrenNodeUids(currentParentUid)) {
                        const childNode = await this.sdk.getNode(childUid);
                        if (
                            childNode.type === NodeType.Folder &&
                            !childNode.trashTime &&
                            childNode.name.ok &&
                            childNode.name.value === part
                        ) {
                            foundUid = childUid;
                            break;
                        }
                    }

                    if (foundUid) {
                        currentParentUid = foundUid;
                    } else {
                        // Create remote directory
                        const node = await this.sdk.createFolder(currentParentUid, part);
                        currentParentUid = node.uid;
                    }

                    // Map folder in db
                    this.db.setMapping({
                        local_path: prefix,
                        node_uid: currentParentUid,
                        is_dir: 1,
                        size: 0,
                        mtime: Date.now(),
                        sha1: '',
                        remote_revision_uid: '',
                        remote_mtime: Date.now(),
                    });
                }
            }

            return currentParentUid;
        });
    }

    // Trash node remotely
    private async deleteRemoteNode(nodeUid: string, relativePath: string): Promise<void> {
        this.db.log(relativePath, 'delete_remote', 'syncing', 'Deleting file from cloud');
        try {
            await this.runWithRetry(async () => {
                for await (const result of this.sdk.trashNodes([nodeUid])) {
                    if (!result.ok) throw result.error;
                }
            });
            this.db.deleteMapping(relativePath);
            this.db.log(relativePath, 'delete_remote', 'completed', 'Cloud file moved to trash');
        } catch (err: any) {
            this.logger.error(`Failed to delete remote node ${nodeUid}:`, err);
            this.db.log(relativePath, 'delete_remote', 'failed', `Remote delete error: ${err.message || err}`);
            throw err;
        }
    }

    // Delete file locally
    private async deleteLocalFile(relativePath: string): Promise<void> {
        const localPath = this.resolveLocalPath(relativePath);
        if (!existsSync(localPath)) {
            this.db.deleteMapping(relativePath);
            return;
        }

        this.db.log(relativePath, 'delete_local', 'syncing', 'Deleting local file');
        this.ignoredLocalChanges.add(localPath);
        try {
            await rm(localPath, { recursive: true, force: true });
            this.db.deleteMapping(relativePath);
            this.db.log(relativePath, 'delete_local', 'completed', 'Deleted local file');
        } catch (err: any) {
            this.logger.error(`Failed to delete local file ${relativePath}:`, err);
            this.db.log(relativePath, 'delete_local', 'failed', `Local delete error: ${err.message || err}`);
            throw err;
        } finally {
            this.ignoredLocalChanges.delete(localPath);
        }
    }

    private resolveLocalPath(relativePath: string): string {
        return path.join(this.localSyncRoot, relativePath);
    }

    private countLocalFiles(dir: string): number {
        if (!existsSync(dir)) return 0;
        let count = 0;
        try {
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue; // ignore hidden files/folders
                count++;
                if (entry.isDirectory()) {
                    count += this.countLocalFiles(path.join(dir, entry.name));
                }
            }
        } catch (err) {
            this.logger.warn(`Failed to count files in ${dir}:`, err);
        }
        return count;
    }

    getBulkDeletionCount(): number {
        return this.recentDeletions.length;
    }

    async confirmBulkDeletions(): Promise<void> {
        this.logger.info("User confirmed bulk deletions. Resuming sync.");
        this.bulkDeletionWarning = false;
        this.recentDeletions = [];
        await this.resume();
    }

    async restoreBulkDeletions(): Promise<void> {
        this.logger.info("User rejected bulk deletions. Restoring local files from remote cloud.");
        this.bulkDeletionWarning = false;
        this.recentDeletions = [];
        this.db.clearMappings();
        await this.resume();
    }

    private async runWithRetry<T>(fn: () => Promise<T>, retries = 5, initialDelay = 1000): Promise<T> {
        let delay = initialDelay;
        for (let i = 0; i < retries; i++) {
            try {
                return await fn();
            } catch (error: any) {
                const isNetworkError = this.isNetworkError(error);
                this.logger.warn(`Operation failed (attempt ${i + 1}/${retries}). Error: ${error.message || error}. NetworkError=${isNetworkError}`);
                
                if (i === retries - 1) {
                    if (isNetworkError) {
                        this.startOfflineMonitor();
                    }
                    throw error;
                }

                await new Promise((resolve) => setTimeout(resolve, delay));
                delay *= 2; // Exponential backoff
            }
        }
        throw new Error('Unreachable retry loop state');
    }

    private isNetworkError(error: any): boolean {
        const msg = (error.message || '').toLowerCase();
        const code = error.code || '';
        return (
            code === 'ENOTFOUND' ||
            code === 'EAI_AGAIN' ||
            code === 'ECONNRESET' ||
            code === 'ETIMEDOUT' ||
            code === 'EHOSTUNREACH' ||
            code === 'ENETUNREACH' ||
            code === 'ECONNREFUSED' ||
            msg.includes('fetch failed') ||
            msg.includes('network error') ||
            msg.includes('timeout') ||
            msg.includes('offline')
        );
    }

    private startOfflineMonitor(): void {
        if (this.checkConnectionInterval) return;

        this.logger.warn('Network offline detected. Starting connection monitor.');
        this.db.log('system', 'system', 'failed', 'Network offline. Synchronization paused until connection is restored.');
        this.isOffline = true;
        this.emit('statusChanged');

        this.checkConnectionInterval = setInterval(async () => {
            try {
                this.logger.debug('Checking connection state...');
                // Try a lightweight request to verify connection
                await this.sdk.getQuota();
                this.logger.info('Connection restored!');
                this.db.log('system', 'system', 'completed', 'Network connection restored. Resuming synchronization.');
                
                this.isOffline = false;
                this.emit('statusChanged');
                
                clearInterval(this.checkConnectionInterval);
                this.checkConnectionInterval = null;

                // Trigger a full sync to reconcile any changes missed while offline
                this.forceSync().catch((err) => {
                    this.logger.error('Post-offline force sync failed:', err);
                });
            } catch (err) {
                // Still offline
                this.logger.debug('Connection check failed, still offline.');
            }
        }, 15000);
    }
}
