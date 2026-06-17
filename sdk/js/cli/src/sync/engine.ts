import {
  DriveEvent,
  DriveEventType,
  NodeEntity,
  NodeType,
  ProtonDriveClient,
  SDKEvent,
} from "@protontech/drive-sdk";
import chokidar from "chokidar";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, statSync, utimesSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { getSha1 } from "../commands/fileSystem/digest";
import { SyncDatabase, SyncMapping } from "./db";
import { IgnoreMatcher, PROTONIGNORE_FILENAME } from "./ignore";
import type { EventsProvider } from "../events/interface";

export class SyncEngine extends EventEmitter {
  private db: SyncDatabase;
  private sdk: ProtonDriveClient;
  private auth: any;
  private logger: any;
  private localSyncRoot: string;
  private remoteRootUid: string = "";
  private isPaused: boolean = false;
  private isScanning: boolean = false;
  private isStarted: boolean = false;
  private ignoredLocalChanges: Set<string> = new Set();
  private watcher: any = null;
  private remoteSubscription: any = null;
  private activeTransfers: Map<
    string,
    { type: "upload" | "download"; size: number; transferred: number }
  > = new Map();
  private localScanCount: number = 0;
  private remoteScanCount: number = 0;
  private wasRootDeleted: boolean = false;
  private recentDeletions: {
    timestamp: number;
    path: string;
    nodeUid: string;
  }[] = [];
  private bulkDeletionWarning: boolean = false;
  private isBulkDeletionConfirmed: boolean = false;
  private isOffline: boolean = false;
  private checkConnectionInterval: any = null;
  private concurrencyLimit: number = 3;
  private activeReconciles: Set<string> = new Set();
  private offlineMonitorPromise: Promise<void> | null = null;
  private unsubscribeOffline: (() => void)[] = [];
  private cachedLocalFileCount: number = 0;
  /** In-memory count of DB mappings — avoids full table scan on every unlink event. */
  private cachedMappingCount: number = 0;
  private livenessInterval: any = null;
  private activeFolderCreations: Map<string, Promise<string>> = new Map();
  private activeDownloads: Map<string, { abort: () => Promise<void> }> =
    new Map();
  private activeUploads: Map<string, { abort: () => Promise<void> }> =
    new Map();
  private pendingLocalDeletes: Map<
    string,
    { timestamp: number; isDir: boolean; nodeUid: string }
  > = new Map();
  /** Ignore matcher — enforces built-in defaults and user .protonignore rules. */
  private ignoreMatcher!: IgnoreMatcher;
  private eventsProvider?: EventsProvider;

  constructor(
    db: SyncDatabase,
    sdk: ProtonDriveClient,
    auth: any,
    logger: any,
    eventsProvider?: EventsProvider,
  ) {
    super();
    this.db = db;
    this.sdk = sdk;
    this.auth = auth;
    this.logger = logger;
    this.eventsProvider = eventsProvider;

    // Load config with environment variable override
    const envPath = process.env.PROTON_MOUNT_POINT;
    if (envPath) {
      this.db.setConfig("local_sync_path", path.resolve(envPath));
    }

    const defaultPath = path.join(homedir(), "P-Drive");
    this.localSyncRoot = path.resolve(
      this.db.getConfig("local_sync_path", defaultPath),
    );
    this.isPaused = this.db.getConfig("is_sync_paused", "0") === "1";
    this.ignoreMatcher = new IgnoreMatcher(this.localSyncRoot);
  }

  getLocalSyncRoot(): string {
    return this.localSyncRoot;
  }

  async setLocalSyncRoot(newPath: string): Promise<void> {
    const resolvedPath = path.resolve(newPath);
    if (resolvedPath === this.localSyncRoot) return;

    this.db.log(
      "system",
      "system",
      "syncing",
      `Changing sync folder to ${resolvedPath}`,
    );

    // Stop current sync
    const wasRunning = this.isStarted;
    await this.stop();

    this.localSyncRoot = resolvedPath;
    this.db.setConfig("local_sync_path", resolvedPath);
    // Rebuild ignore rules for the new sync root
    this.ignoreMatcher = new IgnoreMatcher(resolvedPath);

    // Reset database mappings (since we changed sync folders)
    this.db.clearMappings();

    if (wasRunning) {
      await this.start();
    }
    this.emit("statusChanged");
  }

  getStatus(): string {
    if (!this.auth.isLoggedIn()) return "auth_required";
    if (this.isOffline) return "offline";
    if (this.bulkDeletionWarning) return "bulk_deletion_warning";
    if (this.isPaused) return "paused";
    if (this.isScanning) return "scanning";
    if (this.activeTransfers.size > 0) return "syncing";
    if (this.isStarted) return "synced";
    return "idle";
  }

  getActiveTransfers() {
    return Array.from(this.activeTransfers.entries()).map(
      ([filePath, val]) => ({
        filePath,
        type: val.type,
        size: val.size,
        transferred: val.transferred,
        percent:
          val.size > 0 ? Math.round((val.transferred / val.size) * 100) : 0,
      }),
    );
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

    this.logger.info(
      `Running one-time Sync Engine run at ${this.localSyncRoot}`,
    );
    this.db.log(
      "system",
      "system",
      "syncing",
      `Running one-time sync pass at ${this.localSyncRoot}`,
    );

    try {
      // Get Proton Drive remote root folder
      const rootFolder = await this.sdk.getMyFilesRootFolder();
      this.remoteRootUid = rootFolder.uid;

      // Perform full reconciliation
      await this.forceSync();
    } catch (error: any) {
      this.logger.error("One-time sync failed:", error);
      this.db.log(
        "system",
        "system",
        "failed",
        `One-time sync failed: ${error.message || error}`,
      );
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.watcher || !this.auth.isLoggedIn()) return; // Already started or not authenticated
    this.isStarted = true;
    this.isPaused = false;
    this.db.setConfig("is_sync_paused", "0");

    // Ensure local sync directory exists
    if (!existsSync(this.localSyncRoot)) {
      this.wasRootDeleted = true;
      mkdirSync(this.localSyncRoot, { recursive: true });
    } else {
      this.wasRootDeleted = false;
    }

    this.logger.info(`Starting Sync Engine at ${this.localSyncRoot}`);
    this.db.log(
      "system",
      "system",
      "completed",
      `Sync engine started at ${this.localSyncRoot}`,
    );

    try {
      // Get Proton Drive remote root folder
      const rootFolder = await this.sdk.getMyFilesRootFolder();
      this.remoteRootUid = rootFolder.uid;

      // Setup the local watcher immediately so we don't miss any offline changes/events
      this.setupWatcher();

      // Perform startup fast reconciliation in the background
      this.startupSync().catch((err) => {
        this.logger.error("Background startup sync failed:", err);
      });

      // Subscribe to remote events
      await this.subscribeToRemoteEvents(rootFolder.treeEventScopeId);

      // Listen to SDK online/offline state change events
      this.unsubscribeOffline.push(
        this.sdk.onMessage(SDKEvent.TransfersPaused, () => {
          this.logger.warn(
            "[offline-listener] SDK detected connection loss (transfers paused).",
          );
          this.startOfflineMonitor();
        }),
      );
      this.unsubscribeOffline.push(
        this.sdk.onMessage(SDKEvent.TransfersResumed, () => {
          this.logger.info(
            "[offline-listener] SDK detected connection recovery (transfers resumed).",
          );
          this.handleOnlineEvent();
        }),
      );

      // Start a liveness monitor to detect sleep/resume and stale connections
      this.startLivenessMonitor();
    } catch (error: any) {
      this.logger.error("Failed to start Sync Engine:", error);
      this.db.log(
        "system",
        "system",
        "failed",
        `Start failed: ${error.message || error}`,
      );
      this.emit("error", error);
      this.isStarted = false;
    }
    this.emit("statusChanged");
  }

  async stop(): Promise<void> {
    this.logger.info("Stopping Sync Engine");
    this.isStarted = false;

    // Abort all active downloads
    for (const [relPath, dl] of this.activeDownloads.entries()) {
      this.logger.info(`Aborting active download for ${relPath}`);
      await dl.abort().catch(() => {});
    }
    this.activeDownloads.clear();

    // Abort all active uploads
    for (const [relPath, ul] of this.activeUploads.entries()) {
      this.logger.info(`Aborting active upload for ${relPath}`);
      await ul.abort().catch(() => {});
    }
    this.activeUploads.clear();

    if (this.checkConnectionInterval) {
      clearInterval(this.checkConnectionInterval);
      this.checkConnectionInterval = null;
    }
    if (this.livenessInterval) {
      clearInterval(this.livenessInterval);
      this.livenessInterval = null;
    }
    this.isOffline = false;

    // Unsubscribe from offline listeners
    for (const unsub of this.unsubscribeOffline) {
      try {
        unsub();
      } catch (err) {}
    }
    this.unsubscribeOffline = [];

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    if (this.remoteSubscription) {
      try {
        this.remoteSubscription.dispose();
      } catch (err) {
        this.logger.warn("Error disposing remote event subscription:", err);
      }
      this.remoteSubscription = null;
    }

    this.emit("statusChanged");
  }

  async pause(): Promise<void> {
    if (this.isPaused) return;
    this.isPaused = true;
    this.db.setConfig("is_sync_paused", "1");
    this.db.log("system", "system", "completed", "Synchronization paused");
    await this.stop();
    this.emit("statusChanged");
  }

  async resume(): Promise<void> {
    if (!this.isPaused) return;
    this.isPaused = false;
    this.db.setConfig("is_sync_paused", "0");
    this.db.log("system", "system", "completed", "Synchronization resumed");

    // Process all pending deletions that were paused
    const pendingDeletes = Array.from(this.pendingLocalDeletes.entries());
    this.pendingLocalDeletes.clear();
    for (const [relPath, pending] of pendingDeletes) {
      try {
        // Check if any ancestor is also in the list of pending deletes
        let ancestorPending = false;
        const parts = relPath.split("/");
        let current = "";
        for (let i = 0; i < parts.length - 1; i++) {
          current = current ? `${current}/${parts[i]}` : parts[i];
          if (pendingDeletes.some(([p]) => p === current)) {
            ancestorPending = true;
            break;
          }
        }

        if (ancestorPending) {
          this.db.deleteMapping(relPath);
        } else {
          if (!this.activeReconciles.has(relPath)) {
            await this.deleteRemoteNode(pending.nodeUid, relPath);
          }
        }
      } catch (err) {
        this.logger.error(
          `Failed to execute confirmed deletion for ${relPath}:`,
          err,
        );
      }
    }

    await this.start();
    this.emit("statusChanged");
  }

  async forceSync(): Promise<void> {
    if (this.isScanning) return;
    this.isScanning = true;
    this.emit("statusChanged");
    this.db.log("system", "system", "syncing", "Starting full repository scan");
    this.localScanCount = 0;
    this.remoteScanCount = 0;

    try {
      this.logger.info("Scanning local directory...");
      this.db.log(
        "system",
        "system",
        "syncing",
        "Scanning local filesystem...",
      );
      const localFiles = await this.scanLocalDir(this.localSyncRoot);
      this.cachedLocalFileCount = localFiles.size;
      this.db.log(
        "system",
        "system",
        "syncing",
        `Local scan complete. Discovered ${localFiles.size} items.`,
      );

      this.logger.info("Scanning remote Proton directory...");
      this.db.log(
        "system",
        "system",
        "syncing",
        "Scanning remote cloud directory...",
      );
      const remoteFiles = new Map<string, NodeEntity>();
      await this.scanRemoteDir(this.remoteRootUid, "", remoteFiles);
      this.db.log(
        "system",
        "system",
        "syncing",
        `Remote scan complete. Discovered ${remoteFiles.size} items.`,
      );

      this.logger.info("Reconciling differences...");
      this.db.log(
        "system",
        "system",
        "syncing",
        "Comparing files and applying synchronization rules...",
      );
      await this.reconcile(localFiles, remoteFiles);

      this.db.log(
        "system",
        "system",
        "completed",
        "Full synchronization complete",
      );
      this.db.checkpoint();
    } catch (error: any) {
      this.logger.error("Full sync reconciliation failed:", error);
      this.db.log(
        "system",
        "system",
        "failed",
        `Full sync failed: ${error.message || error}`,
      );
    } finally {
      this.isScanning = false;
      this.isBulkDeletionConfirmed = false;
      this.emit("statusChanged");
    }
  }

  // Fast startup reconciliation using local scan and event logs
  // Performs full scan and reconciliation on startup
  async startupSync(): Promise<void> {
    await this.cleanupTempFiles(this.localSyncRoot);
    const mappingsCount = this.db.getAllMappings().length;
    if (mappingsCount === 0) {
      this.logger.info(
        "Performing initial full repository scan and reconciliation.",
      );
      await this.forceSync();
    } else {
      this.logger.info(
        "Performing fast startup repository scan and reconciliation.",
      );
      await this.fastSync();
    }
  }

  async fastSync(): Promise<void> {
    if (this.isScanning) return;
    this.isScanning = true;
    this.emit("statusChanged");
    this.db.log(
      "system",
      "system",
      "syncing",
      "Starting fast startup reconciliation",
    );
    this.localScanCount = 0;

    try {
      this.logger.info("Scanning local directory...");
      this.db.log(
        "system",
        "system",
        "syncing",
        "Scanning local filesystem...",
      );
      const localFiles = await this.scanLocalDir(this.localSyncRoot);
      this.cachedLocalFileCount = localFiles.size;
      this.db.log(
        "system",
        "system",
        "syncing",
        `Local scan complete. Discovered ${localFiles.size} items.`,
      );

      this.logger.info("Performing fast reconciliation of local changes...");
      this.db.log(
        "system",
        "system",
        "syncing",
        "Comparing local changes against database mappings...",
      );

      const mappingsArr = this.db.getAllMappings();
      const mappingsCache = new Map<string, SyncMapping>(
        mappingsArr.map((m) => [m.local_path, m]),
      );

      // 1. Identify local additions and modifications
      const pendingUploads: { path: string; isDir: boolean }[] = [];
      for (const [relPath, local] of localFiles) {
        const mapped = mappingsCache.get(relPath);
        if (!mapped) {
          pendingUploads.push({ path: relPath, isDir: local.isDir });
        } else {
          const isDir = local.isDir;
          const size = isDir ? 0 : local.size;
          const localChanged =
            size !== mapped.size || Math.abs(local.mtime - mapped.mtime) > 2000;
          if (localChanged) {
            if (isDir) {
              // Directory metadata changed locally, update database mapping directly
              this.db.setMapping({
                ...mapped,
                mtime: local.mtime,
                remote_mtime: local.mtime,
              });
            } else {
              pendingUploads.push({ path: relPath, isDir });
            }
          }
        }
      }

      // 2. Identify local deletions
      const pendingDeletes: SyncMapping[] = [];
      for (const mapped of mappingsArr) {
        if (!localFiles.has(mapped.local_path)) {
          if (
            this.ignoreMatcher.shouldIgnore(
              mapped.local_path,
              mapped.is_dir === 1,
            )
          ) {
            this.logger.info(
              `Mapping for ${mapped.local_path} is now ignored. Removing mapping.`,
            );
            this.db.deleteMapping(mapped.local_path);
            this.cachedMappingCount--;
            continue;
          }
          pendingDeletes.push(mapped);
        }
      }

      // 3. Process deletions first
      for (const mapped of pendingDeletes) {
        if (this.isPaused || !this.isStarted) break;
        await this.deleteRemoteNode(mapped.node_uid, mapped.local_path);
      }

      // 4. Process uploads (folders first, then files in parallel)
      const foldersToUpload = pendingUploads
        .filter((u) => u.isDir)
        .sort((a, b) => a.path.split("/").length - b.path.split("/").length);
      const filesToUpload = pendingUploads.filter((u) => !u.isDir);

      for (const folder of foldersToUpload) {
        if (this.isPaused || !this.isStarted) break;
        await this.syncLocalToRemote(folder.path, true);
      }

      const queue = [...filesToUpload];
      const workers = Array.from(
        { length: Math.min(this.concurrencyLimit, queue.length) },
        async () => {
          while (queue.length > 0) {
            if (this.isPaused || !this.isStarted) break;
            const item = queue.shift();
            if (item) {
              await this.syncLocalToRemote(item.path, false);
            }
          }
        },
      );
      await Promise.all(workers);

      this.db.log(
        "system",
        "system",
        "completed",
        "Fast startup reconciliation complete",
      );
      this.db.checkpoint();
    } catch (error: any) {
      this.logger.error("Fast sync failed:", error);
      this.db.log(
        "system",
        "system",
        "failed",
        `Fast sync failed: ${error.message || error}`,
      );
    } finally {
      this.isScanning = false;
      this.emit("statusChanged");
    }
  }

  // Recursively scan local files (async — does not block the event loop on large directories)
  private async scanLocalDir(
    dir: string,
    relativePath: string = "",
  ): Promise<Map<string, { size: number; mtime: number; isDir: boolean }>> {
    const results = new Map<
      string,
      { size: number; mtime: number; isDir: boolean }
    >();
    const absoluteDir = path.join(dir, relativePath);

    if (!existsSync(absoluteDir)) return results;

    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch (err) {
      this.logger.warn(`Failed to read directory ${absoluteDir}:`, err);
      return results;
    }

    // Stat all entries in the current directory concurrently
    await Promise.all(
      entries.map(async (entry) => {
        const relPath = relativePath
          ? `${relativePath}/${entry.name}`
          : entry.name;
        const absPath = path.join(dir, relPath);

        try {
          const st = await stat(absPath);
          const isDir = st.isDirectory();

          // Skip ignored paths early — avoids traversing node_modules etc.
          if (this.ignoreMatcher.shouldIgnore(relPath, isDir)) {
            this.logger.debug(`[ignore] Skipping ignored path: ${relPath}`);
            return;
          }

          results.set(relPath, {
            size: isDir ? 0 : st.size,
            mtime: st.mtimeMs,
            isDir,
          });

          this.localScanCount++;
          // Log progress every 500 files — reducing DB writes from ~2000 to ~200 for large repos
          if (this.localScanCount % 500 === 0) {
            this.logger.info(
              `Local scan: discovered ${this.localScanCount} files...`,
            );
          }

          if (isDir) {
            const subResults = await this.scanLocalDir(dir, relPath);
            for (const [subRel, subStat] of subResults) {
              results.set(subRel, subStat);
            }
          }
        } catch (err) {
          this.logger.warn(`Failed to stat local file ${relPath}:`, err);
        }
      }),
    );

    return results;
  }

  // Concurrently scan remote Proton folder
  private async scanRemoteDir(
    rootUid: string,
    rootRelPath: string,
    result: Map<string, NodeEntity>,
  ): Promise<void> {
    const folderQueue: { uid: string; relPath: string }[] = [
      { uid: rootUid, relPath: rootRelPath },
    ];
    let activeTasks = 0;

    const workers = Array.from({ length: this.concurrencyLimit }, async () => {
      while (true) {
        if (folderQueue.length === 0) {
          if (activeTasks === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }

        const current = folderQueue.shift();
        if (!current) continue;

        activeTasks++;
        try {
          const { uid: folderUid, relPath: relativePath } = current;

          const childrenUids = await this.runWithRetry(async () => {
            const uids: string[] = [];
            for await (const uid of this.sdk.iterateFolderChildrenNodeUids(
              folderUid,
            )) {
              uids.push(uid);
            }
            return uids;
          });

          const childFolders: { uid: string; relPath: string }[] = [];
          const chunkSize = 50;
          for (let i = 0; i < childrenUids.length; i += chunkSize) {
            const chunk = childrenUids.slice(i, i + chunkSize);
            const chunkFolders = await this.runWithRetry(async () => {
              const folders: { uid: string; relPath: string }[] = [];
              for await (const node of this.sdk.iterateNodes(chunk)) {
                if ("missingUid" in node) continue;
                if (node.trashTime) continue;

                this.remoteScanCount++;
                if (this.remoteScanCount % 200 === 0) {
                  this.logger.info(
                    `Remote scan: discovered ${this.remoteScanCount} cloud files...`,
                  );
                  this.db.log(
                    "system",
                    "system",
                    "syncing",
                    `Remote scan: discovered ${this.remoteScanCount} cloud files...`,
                  );
                }

                const name = node.name.ok ? node.name.value : "degraded_name";
                const relPath = relativePath ? `${relativePath}/${name}` : name;

                result.set(relPath, node);

                if (node.type === NodeType.Folder) {
                  folders.push({ uid: node.uid, relPath });
                }
              }
              return folders;
            });
            childFolders.push(...chunkFolders);
          }

          folderQueue.push(...childFolders);
        } catch (error: any) {
          this.logger.error(
            `[Worker] Error scanning folder ${current.uid}:`,
            error,
          );
          throw error;
        } finally {
          activeTasks--;
        }
      }
    });

    await Promise.all(workers);
  }

  // Two-way reconciliation algorithm
  private async reconcile(
    localFiles: Map<string, { size: number; mtime: number; isDir: boolean }>,
    remoteFiles: Map<string, NodeEntity>,
  ): Promise<void> {
    // Load all DB mappings once and build in-memory caches — eliminates O(n²) table scans
    const mappingsArr = this.db.getAllMappings();
    const mappingsCache = new Map<string, SyncMapping>(
      mappingsArr.map((m) => [m.local_path, m]),
    );
    // Keep the cached count in sync with the DB for use in hot watcher paths
    this.cachedMappingCount = mappingsArr.length;

    // Helpers that keep the DB and in-memory cache in sync
    const cacheSet = (m: SyncMapping) => {
      this.db.setMapping(m);
      mappingsCache.set(m.local_path, m);
      this.cachedMappingCount = mappingsCache.size;
    };
    const cacheDel = (p: string) => {
      this.db.deleteMapping(p);
      mappingsCache.delete(p);
      this.cachedMappingCount = mappingsCache.size;
    };

    // Pre-reconciliation check: Detect remote renames/moves of folders and files
    const remoteUidToPath = new Map<string, string>();
    for (const [relPath, node] of remoteFiles) {
      remoteUidToPath.set(node.uid, relPath);
    }

    for (const mapping of mappingsArr) {
      if (remoteUidToPath.has(mapping.node_uid)) {
        const newRelPath = remoteUidToPath.get(mapping.node_uid)!;
        if (newRelPath !== mapping.local_path) {
          const oldRelPath = mapping.local_path;
          const oldLocalPath = this.resolveLocalPath(oldRelPath);
          const newLocalPath = this.resolveLocalPath(newRelPath);

          this.logger.info(
            `Detected remote rename/move of node ${mapping.node_uid} from ${oldRelPath} to ${newRelPath}`,
          );
          this.db.log(
            newRelPath,
            "rename_local",
            "completed",
            `Renaming local path from ${oldRelPath}`,
          );

          // Ignore both paths for long enough for Chokidar to process the rename event
          this.ignorePathTemporarily(oldLocalPath, 3000);
          this.ignorePathTemporarily(newLocalPath, 3000);
          try {
            if (existsSync(oldLocalPath)) {
              const parentDir = path.dirname(newLocalPath);
              if (!existsSync(parentDir)) {
                mkdirSync(parentDir, { recursive: true });
              }
              await rename(oldLocalPath, newLocalPath);
            }
          } catch (err) {
            this.logger.error(
              `Failed to rename local path from ${oldRelPath} to ${newRelPath}:`,
              err,
            );
          }

          // Update parent mapping in database and cache
          cacheDel(oldRelPath);
          cacheSet({ ...mapping, local_path: newRelPath });

          // Update parent key in localFiles map
          const parentLocal = localFiles.get(oldRelPath);
          if (parentLocal) {
            localFiles.delete(oldRelPath);
            localFiles.set(newRelPath, parentLocal);
          }

          // If it is a directory, update child mappings using in-memory cache (no extra DB call)
          if (mapping.is_dir === 1) {
            for (const [mPath, m] of Array.from(mappingsCache.entries())) {
              if (mPath.startsWith(`${oldRelPath}/`)) {
                const suffix = mPath.slice(oldRelPath.length);
                const newChildPath = `${newRelPath}${suffix}`;

                cacheDel(mPath);
                cacheSet({ ...m, local_path: newChildPath });

                const childLocal = localFiles.get(mPath);
                if (childLocal) {
                  localFiles.delete(mPath);
                  localFiles.set(newChildPath, childLocal);
                }
              }
            }
          }
        }
      }
    }

    // Local rename/move detection — use the live cache instead of another DB call
    const mappingsAfterRemote = Array.from(mappingsCache.values());
    const localDeletes = mappingsAfterRemote.filter(
      (m) => !localFiles.has(m.local_path),
    );
    const localAdds = Array.from(localFiles.keys()).filter(
      (p) => !mappingsCache.has(p) && !remoteFiles.has(p),
    );

    // 1. Match directory renames/moves first (to optimize nested transfers)
    const delDirs = localDeletes.filter((m) => m.is_dir === 1);
    const addDirs = localAdds.filter((p) => localFiles.get(p)?.isDir === true);

    for (const addPath of [...addDirs]) {
      const addInfo = localFiles.get(addPath)!;

      const addChildren = Array.from(localFiles.entries())
        .filter(([p]) => path.dirname(p) === addPath)
        .map(([p, info]) => ({
          name: path.basename(p),
          size: info.size,
          isDir: info.isDir,
        }));

      for (const matchedDel of [...delDirs]) {
        const delChildren = mappingsAfterRemote
          .filter((m) => path.dirname(m.local_path) === matchedDel.local_path)
          .map((m) => ({
            name: path.basename(m.local_path),
            size: m.size,
            isDir: m.is_dir === 1,
          }));

        if (addChildren.length !== delChildren.length) continue;

        let match = true;
        for (const ac of addChildren) {
          const dc = delChildren.find(
            (d) =>
              d.name === ac.name && d.size === ac.size && d.isDir === ac.isDir,
          );
          if (!dc) {
            match = false;
            break;
          }
        }

        if (match) {
          this.logger.info(
            `Detected local directory rename/move of node ${matchedDel.node_uid} from ${matchedDel.local_path} to ${addPath}`,
          );
          this.db.log(
            addPath,
            "rename_remote",
            "syncing",
            `Renaming remote folder from ${matchedDel.local_path}`,
          );

          // A. Handle move
          const oldParent = path.dirname(matchedDel.local_path);
          const newParent = path.dirname(addPath);
          if (oldParent !== newParent) {
            const newParentUid =
              newParent === "."
                ? this.remoteRootUid
                : await this.ensureRemoteParentFolder(newParent);
            await this.runWithRetry(async () => {
              for await (const result of this.sdk.moveNodes(
                [matchedDel.node_uid],
                newParentUid,
              )) {
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

          // C. Update DB mappings of parent and children via cache helpers
          cacheDel(matchedDel.local_path);
          cacheSet({
            ...matchedDel,
            local_path: addPath,
            mtime: addInfo.mtime,
          });

          const oldPrefix = matchedDel.local_path;
          const newPrefix = addPath;

          for (const [mPath, m] of Array.from(mappingsCache.entries())) {
            if (mPath.startsWith(`${oldPrefix}/`)) {
              const suffix = mPath.slice(oldPrefix.length);
              const newChildPath = `${newPrefix}${suffix}`;

              cacheDel(mPath);
              cacheSet({ ...m, local_path: newChildPath });

              const childLocal = localFiles.get(mPath);
              if (childLocal) {
                localFiles.delete(mPath);
                localFiles.set(newChildPath, childLocal);
              }

              const addIdx = localAdds.indexOf(mPath);
              if (addIdx !== -1) localAdds.splice(addIdx, 1);

              const delIdx = localDeletes.findIndex(
                (d) => d.local_path === mPath,
              );
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

          this.db.log(
            addPath,
            "rename_remote",
            "completed",
            `Renamed remote folder successfully`,
          );
          break;
        }
      }
    }

    // 2. Match file renames/moves
    for (const addPath of [...localAdds]) {
      const addInfo = localFiles.get(addPath)!;
      if (addInfo.isDir) continue;

      const candidates = localDeletes.filter(
        (m) => m.is_dir === 0 && m.size === addInfo.size,
      );
      if (candidates.length === 0) continue;

      try {
        const addSha1 = await getSha1(this.resolveLocalPath(addPath));
        const matched = candidates.find((m) => m.sha1 === addSha1);
        if (matched) {
          this.logger.info(
            `Detected local file rename/move of node ${matched.node_uid} from ${matched.local_path} to ${addPath}`,
          );
          this.db.log(
            addPath,
            "rename_remote",
            "syncing",
            `Renaming remote file from ${matched.local_path}`,
          );

          // A. Handle move
          const oldParent = path.dirname(matched.local_path);
          const newParent = path.dirname(addPath);
          if (oldParent !== newParent) {
            const newParentUid =
              newParent === "."
                ? this.remoteRootUid
                : await this.ensureRemoteParentFolder(newParent);
            await this.runWithRetry(async () => {
              for await (const result of this.sdk.moveNodes(
                [matched.node_uid],
                newParentUid,
              )) {
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

          // C. Update DB mapping via cache helpers
          cacheDel(matched.local_path);
          cacheSet({
            ...matched,
            local_path: addPath,
            sha1: addSha1,
            mtime: addInfo.mtime,
          });

          localAdds.splice(localAdds.indexOf(addPath), 1);
          localDeletes.splice(localDeletes.indexOf(matched), 1);
          this.db.log(
            addPath,
            "rename_remote",
            "completed",
            `Renamed remote file successfully`,
          );
        }
      } catch (err) {
        this.logger.error(
          `Error during local rename detection for ${addPath}:`,
          err,
        );
      }
    }

    const allPaths = new Set([...localFiles.keys(), ...remoteFiles.keys()]);

    // Safeguard against accidental mass remote deletions (e.g. unmounted drive or cleared folder)
    const plannedRemoteDeletes: {
      timestamp: number;
      path: string;
      nodeUid: string;
    }[] = [];
    for (const relPath of allPaths) {
      const local = localFiles.get(relPath);
      const remote = remoteFiles.get(relPath);
      const mapped = mappingsCache.get(relPath);
      if (!local && remote && mapped) {
        plannedRemoteDeletes.push({
          timestamp: Date.now(),
          path: relPath,
          nodeUid: mapped.node_uid,
        });
      }
    }

    const mappedCount = mappingsCache.size;
    const localFilesCount = localFiles.size;

    const isDiskEmptyWipe =
      localFilesCount <= 1 &&
      mappedCount > 5 &&
      plannedRemoteDeletes.length > 0;
    const isBulkDelete =
      plannedRemoteDeletes.length >= 10 &&
      plannedRemoteDeletes.length > mappedCount * 0.3;

    if (!this.isBulkDeletionConfirmed && (isDiskEmptyWipe || isBulkDelete)) {
      this.logger.warn(
        `Startup bulk deletion safeguard triggered! plannedDeletes=${plannedRemoteDeletes.length}, mappedCount=${mappedCount}`,
      );
      this.recentDeletions = plannedRemoteDeletes;
      this.bulkDeletionWarning = true;
      this.isPaused = true;
      this.db.setConfig("is_sync_paused", "1");

      const msg = isDiskEmptyWipe
        ? `Local sync folder is empty but has ${mappedCount} tracked files. Sync paused to protect remote cloud files from accidental wipe.`
        : `Accidental deletion safeguard: ${plannedRemoteDeletes.length} remote files are scheduled to be deleted. Sync paused.`;

      this.db.log("system", "system", "failed", msg);
      this.emit("statusChanged");
      return; // Abort reconciliation to prevent trashing remote files
    }

    const directoryPaths: string[] = [];
    const filePaths: string[] = [];

    for (const relPath of allPaths) {
      const local = localFiles.get(relPath);
      const remote = remoteFiles.get(relPath);
      const mapped = mappingsCache.get(relPath);
      const isDir =
        (local && local.isDir) ||
        (remote && remote.type === NodeType.Folder) ||
        (mapped && mapped.is_dir);

      if (isDir) {
        directoryPaths.push(relPath);
      } else {
        filePaths.push(relPath);
      }
    }

    // 1. Process directories sequentially, sorted by depth (shallowest first)
    // This ensures parent directories exist before any files are processed/reconciled.
    directoryPaths.sort((a, b) => a.split("/").length - b.split("/").length);
    this.logger.info(
      `Reconciling ${directoryPaths.length} directories sequentially...`,
    );
    for (const relPath of directoryPaths) {
      if (this.isPaused || !this.isStarted) {
        this.logger.info(
          "Sync paused or stopped during directory reconciliation",
        );
        return;
      }
      await this.reconcilePath(
        relPath,
        localFiles.get(relPath),
        remoteFiles.get(relPath),
        mappingsCache.get(relPath),
      );
    }

    // 2. Process file operations in parallel with a concurrency limit
    this.logger.info(
      `Reconciling ${filePaths.length} files in parallel (concurrency limit = ${this.concurrencyLimit})...`,
    );
    const queue = [...filePaths];
    const workers = Array.from(
      { length: Math.min(this.concurrencyLimit, queue.length) },
      async () => {
        while (queue.length > 0) {
          if (this.isPaused || !this.isStarted) {
            break;
          }
          const relPath = queue.shift();
          if (relPath !== undefined) {
            await this.reconcilePath(
              relPath,
              localFiles.get(relPath),
              remoteFiles.get(relPath),
              mappingsCache.get(relPath),
            );
          }
        }
      },
    );
    await Promise.all(workers);

    if (this.isPaused || !this.isStarted) {
      this.logger.info(
        "Sync paused or stopped during file reconciliation. Skipping mapping cleanup.",
      );
      return;
    }

    // Clean up orphaned DB mappings using the in-memory cache (no extra DB scan)
    for (const [mPath] of mappingsCache) {
      if (!localFiles.has(mPath) && !remoteFiles.has(mPath)) {
        this.db.deleteMapping(mPath);
      }
    }
  }

  private async reconcilePath(
    relPath: string,
    local: { size: number; mtime: number; isDir: boolean } | undefined,
    remote: NodeEntity | undefined,
    mapped: SyncMapping | undefined,
  ): Promise<void> {
    // Early check: if the path is ignored, clean up database mapping and skip reconciliation
    const isDir =
      (local && local.isDir) ||
      (remote && remote.type === NodeType.Folder) ||
      (mapped && mapped.is_dir === 1);
    if (this.ignoreMatcher.shouldIgnore(relPath, isDir)) {
      if (mapped) {
        this.logger.info(`Path ${relPath} is now ignored. Removing mapping.`);
        this.db.deleteMapping(relPath);
        this.cachedMappingCount = Math.max(0, this.cachedMappingCount - 1);
      }
      return;
    }

    // Guard against concurrent reconcile of the same path (watcher event + forceSync collision)
    if (this.activeReconciles.has(relPath)) {
      this.logger.debug(
        `Skipping duplicate reconcile for ${relPath} — already in progress`,
      );
      return;
    }
    this.activeReconciles.add(relPath);
    try {
      if (local && remote) {
        // Item exists both locally and remotely
        if (!mapped) {
          // Conflict or fresh setup merge: compare modification times
          const remoteMtime =
            remote.activeRevision?.ok &&
            remote.activeRevision.value.claimedModificationTime
              ? new Date(
                  remote.activeRevision.value.claimedModificationTime,
                ).getTime()
              : remote.modificationTime.getTime();

          const remoteSha1 =
            (remote.type !== NodeType.Folder &&
              remote.activeRevision?.ok &&
              remote.activeRevision.value.claimedDigests?.sha1) ||
            "";
          const localSha1 =
            remote.type !== NodeType.Folder
              ? await getSha1(this.resolveLocalPath(relPath))
              : "";
          const isContentIdentical =
            remote.type !== NodeType.Folder &&
            remoteSha1 &&
            localSha1 === remoteSha1;

          if (
            Math.abs(local.mtime - remoteMtime) < 2000 ||
            isContentIdentical
          ) {
            if (
              isContentIdentical &&
              Math.abs(local.mtime - remoteMtime) >= 2000
            ) {
              this.logger.info(
                `Aligning file modification time for identical content: ${relPath}`,
              );
              try {
                utimesSync(
                  this.resolveLocalPath(relPath),
                  new Date(),
                  new Date(remoteMtime),
                );
                local.mtime = remoteMtime;
              } catch (err) {}
            }
            // Times match closely or content is identical, assume synced
            this.db.setMapping({
              local_path: relPath,
              node_uid: remote.uid,
              is_dir: remote.type === NodeType.Folder ? 1 : 0,
              size: local.size,
              mtime: local.mtime,
              sha1: remote.type === NodeType.Folder ? "" : localSha1,
              remote_revision_uid: remote.activeRevision?.ok
                ? remote.activeRevision.value.uid
                : "",
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
          const localChanged =
            local.size !== mapped.size ||
            Math.abs(local.mtime - mapped.mtime) > 2000;

          const remoteRevUid = remote.activeRevision?.ok
            ? remote.activeRevision.value.uid
            : "";
          const remoteChanged = remoteRevUid !== mapped.remote_revision_uid;

          if (localChanged && remoteChanged) {
            // Conflict! Both sides updated independently
            await this.handleConflict(relPath, remote);
          } else if (localChanged) {
            // Upload local change
            if (local.isDir) {
              // Directory metadata changed locally, update database mapping directly
              this.db.setMapping({
                ...mapped,
                mtime: local.mtime,
                remote_mtime: local.mtime,
              });
            } else {
              await this.syncLocalToRemote(relPath, false);
            }
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
      this.db.log(
        relPath,
        "system",
        "failed",
        `Reconciliation error: ${err.message || err}`,
      );
    } finally {
      this.activeReconciles.delete(relPath);
    }
  }

  // Local file watcher logic using chokidar
  private setupWatcher() {
    if (this.watcher) return;

    this.watcher = chokidar.watch(this.localSyncRoot, {
      // Ignore dotfiles and any path matched by the IgnoreMatcher
      ignored: (absolutePath: string, stats?: import("node:fs").Stats) => {
        const basename = path.basename(absolutePath);
        // Always ignore dotfiles (fast path)
        if (basename.startsWith(".") && basename !== PROTONIGNORE_FILENAME)
          return true;
        const relPath = path.relative(this.localSyncRoot, absolutePath);
        if (!relPath || relPath.startsWith("..")) return false;
        const isDir = stats ? stats.isDirectory() : false;
        return this.ignoreMatcher.shouldIgnore(relPath, isDir);
      },
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 3000, // Waits 3 full seconds of silence before firing sync loops
        pollInterval: 500, // Verifies file metadata updates every 500ms
      },
    });

    this.watcher
      .on("add", (filePath: string) =>
        this.handleLocalChange(filePath, "add", false),
      )
      .on("change", (filePath: string) =>
        this.handleLocalChange(filePath, "change", false),
      )
      .on("unlink", (filePath: string) =>
        this.handleLocalChange(filePath, "unlink", false),
      )
      .on("addDir", (dirPath: string) =>
        this.handleLocalChange(dirPath, "add", true),
      )
      .on("unlinkDir", (dirPath: string) =>
        this.handleLocalChange(dirPath, "unlink", true),
      )
      .on("error", (error: any) => {
        const msg = (error?.message || "").toLowerCase();
        // ENOSPC means the Linux inotify watch limit has been exceeded
        if (
          error?.code === "ENOSPC" ||
          msg.includes("enospc") ||
          msg.includes("no space left")
        ) {
          this.logger.error(
            "[inotify] File watcher hit the system inotify limit (ENOSPC). " +
              "New local file changes may be missed. " +
              "To fix, run: echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p",
          );
          this.db.log(
            "system",
            "system",
            "failed",
            "Watcher hit inotify limit (ENOSPC). New local changes may not be detected. " +
              "Fix: sudo sysctl -w fs.inotify.max_user_watches=524288",
          );
        } else {
          this.logger.error("[watcher] Error:", error);
        }
      });
  }

  private async handleLocalChange(
    absolutePath: string,
    type: "add" | "change" | "unlink",
    isDir: boolean,
  ) {
    if (this.isPaused || this.bulkDeletionWarning) {
      if (type !== "unlink") return;
    }

    // Safety guard: if the local sync root directory itself was deleted or does not exist,
    // do NOT propagate deletions to the remote. This prevents accidental deletion of remote files.
    if (!existsSync(this.localSyncRoot)) {
      this.logger.warn(
        `Local sync root folder ${this.localSyncRoot} was deleted or is missing! Ignoring watcher changes.`,
      );
      this.db.log(
        "system",
        "system",
        "failed",
        `Local sync folder ${this.localSyncRoot} is missing. Halting updates and triggering restore.`,
      );

      // Recreate local sync root safely
      mkdirSync(this.localSyncRoot, { recursive: true });
      this.wasRootDeleted = true;

      // Trigger a rebuild and restoration of files (guard against re-entry while scan is running)
      if (!this.isScanning) {
        this.startupSync().catch((err) =>
          this.logger.error("Triggered startup sync failed:", err),
        );
      }
      return;
    }

    const relativePath = path.relative(this.localSyncRoot, absolutePath);

    if (this.ignoreMatcher.shouldIgnore(relativePath, isDir)) {
      this.logger.debug(
        `Ignoring watcher change at ${relativePath} (matches ignore rules)`,
      );
      return;
    }

    // Reload ignore rules when the user edits .protonignore
    if (
      path.basename(absolutePath) === PROTONIGNORE_FILENAME &&
      (type === "add" || type === "change")
    ) {
      this.ignoreMatcher.reload();
      this.logger.info(
        "[ignore] .protonignore updated — ignore rules reloaded",
      );
      this.db.log(
        "system",
        "system",
        "completed",
        ".protonignore rules reloaded",
      );
      return;
    }

    // Skip changes triggered by downloading files
    if (this.ignoredLocalChanges.has(absolutePath)) {
      this.logger.debug(`Ignoring self-triggered change at ${relativePath}`);
      return;
    }

    this.logger.info(
      `Watcher local change: [${type}] ${relativePath} (isDir=${isDir})`,
    );

    try {
      if (type === "add" || type === "change") {
        // Immediately cancel any pending deletion for this exact path
        if (this.pendingLocalDeletes.has(relativePath)) {
          this.logger.info(
            `Cancelling pending deletion for ${relativePath} due to local recreation/update`,
          );
          this.pendingLocalDeletes.delete(relativePath);
        }

        // Check if this is a moved folder or file from pending deletes
        let matchedOldPath: string | null = null;
        let matchedNodeUid: string | null = null;

        const newName = path.basename(relativePath);
        // Use async stat to avoid blocking the event loop during watcher callbacks
        const fileStat = existsSync(absolutePath)
          ? await stat(absolutePath).catch(() => null)
          : null;
        const size = fileStat && !isDir ? fileStat.size : 0;

        let addSha1 = "";
        if (!isDir && fileStat) {
          try {
            addSha1 = await getSha1(absolutePath);
          } catch (e) {}
        }

        for (const [oldPath, pending] of this.pendingLocalDeletes.entries()) {
          if (pending.isDir === isDir) {
            const oldName = path.basename(oldPath);
            if (isDir) {
              if (oldName === newName) {
                matchedOldPath = oldPath;
                matchedNodeUid = pending.nodeUid;
                break;
              }
            } else {
              const oldMapped = this.db.getMapping(oldPath);
              if (oldMapped) {
                const isSameNameMove =
                  oldName === newName && oldMapped.size === size;
                const isRenameOrHashMove =
                  addSha1 && oldMapped.sha1 === addSha1;
                if (isSameNameMove || isRenameOrHashMove) {
                  matchedOldPath = oldPath;
                  matchedNodeUid = pending.nodeUid;
                  break;
                }
              }
            }
          }
        }

        if (matchedOldPath && matchedNodeUid) {
          this.logger.info(
            `Detected watcher local rename/move: ${matchedOldPath} -> ${relativePath}`,
          );
          this.db.log(
            relativePath,
            "rename_remote",
            "syncing",
            `Moving remote node from ${matchedOldPath}`,
          );

          // Remove from pending deletes
          this.pendingLocalDeletes.delete(matchedOldPath);

          try {
            // A. Handle remote move/rename
            const oldParent = path.dirname(matchedOldPath);
            const newParent = path.dirname(relativePath);
            if (oldParent !== newParent) {
              const newParentUid =
                newParent === "."
                  ? this.remoteRootUid
                  : await this.ensureRemoteParentFolder(newParent);
              await this.runWithRetry(async () => {
                for await (const result of this.sdk.moveNodes(
                  [matchedNodeUid!],
                  newParentUid,
                )) {
                  if (!result.ok) throw result.error;
                }
              });
            }

            const oldName = path.basename(matchedOldPath);
            if (oldName !== newName) {
              await this.runWithRetry(async () => {
                await this.sdk.renameNode(matchedNodeUid!, newName);
              });
            }

            // B. Update DB mapping
            const oldMapped = this.db.getMapping(matchedOldPath);
            this.db.deleteMapping(matchedOldPath);

            const folderMtime = stat ? stat.mtimeMs : Date.now();
            this.db.setMapping({
              local_path: relativePath,
              node_uid: matchedNodeUid,
              is_dir: isDir ? 1 : 0,
              size: isDir ? 0 : (oldMapped?.size ?? size),
              mtime: folderMtime,
              sha1: isDir ? "" : (oldMapped?.sha1 ?? ""),
              remote_revision_uid: isDir
                ? ""
                : (oldMapped?.remote_revision_uid ?? ""),
              remote_mtime: isDir
                ? folderMtime
                : (oldMapped?.remote_mtime ?? folderMtime),
            });

            // C. If directory, recursively rename child mappings in DB
            if (isDir) {
              const allMappings = this.db.getAllMappings();
              for (const m of allMappings) {
                if (m.local_path.startsWith(`${matchedOldPath}/`)) {
                  const suffix = m.local_path.slice(matchedOldPath.length);
                  const newChildPath = `${relativePath}${suffix}`;

                  this.db.deleteMapping(m.local_path);
                  this.db.setMapping({
                    ...m,
                    local_path: newChildPath,
                  });

                  // Cancel any pending delete for child files
                  this.pendingLocalDeletes.delete(m.local_path);
                  this.ignorePathTemporarily(
                    this.resolveLocalPath(newChildPath),
                    3000,
                  );
                }
              }
            }

            this.db.log(
              relativePath,
              "rename_remote",
              "completed",
              "Moved/renamed remote node successfully",
            );
            return;
          } catch (err: any) {
            this.logger.error(`Failed to handle rename/move in watcher:`, err);
          }
        }

        // Standard upload fallback
        if (this.activeReconciles.has(relativePath)) {
          this.logger.debug(
            `Watcher skipping upload for ${relativePath} — reconcile already in progress`,
          );
        } else if (
          this.activeTransfers.has(relativePath) ||
          this.activeDownloads.has(relativePath)
        ) {
          this.logger.debug(
            `Watcher skipping upload for ${relativePath} — active transfer in progress`,
          );
        } else {
          await this.syncLocalToRemote(relativePath, isDir);
        }
      } else if (type === "unlink") {
        const mapped = this.db.getMapping(relativePath);
        if (mapped) {
          this.cachedMappingCount = Math.max(0, this.cachedMappingCount - 1);
          this.cachedLocalFileCount = Math.max(
            0,
            this.cachedLocalFileCount - 1,
          );
          this.pendingLocalDeletes.set(relativePath, {
            timestamp: Date.now(),
            isDir,
            nodeUid: mapped.node_uid,
          });

          setTimeout(async () => {
            const pending = this.pendingLocalDeletes.get(relativePath);
            if (pending) {
              // If bulk deletion warning or manual pause is active, keep it in pendingLocalDeletes
              if (this.isPaused || this.bulkDeletionWarning) {
                return;
              }

              // Optimization: check if any parent directory of this path is also pending deletion
              let ancestorPending = false;
              const parts = relativePath.split("/");
              let current = "";
              for (let i = 0; i < parts.length - 1; i++) {
                current = current ? `${current}/${parts[i]}` : parts[i];
                if (this.pendingLocalDeletes.has(current)) {
                  ancestorPending = true;
                  break;
                }
              }

              if (ancestorPending) {
                this.pendingLocalDeletes.delete(relativePath);
                this.db.deleteMapping(relativePath);
                return;
              }

              // Safeguard: Check if this deletion triggers bulk deletion warning
              const localFilesCount = this.cachedLocalFileCount;
              const mappedCount = this.cachedMappingCount;
              const isEmptyWipe = localFilesCount <= 1 && mappedCount > 5;

              this.recentDeletions.push({
                timestamp: Date.now(),
                path: relativePath,
                nodeUid: pending.nodeUid,
              });
              const cutoff = Date.now() - 15000;
              while (
                this.recentDeletions.length > 0 &&
                this.recentDeletions[0].timestamp < cutoff
              ) {
                this.recentDeletions.shift();
              }

              if (isEmptyWipe || this.recentDeletions.length >= 10) {
                this.logger.warn(
                  `Bulk deletion safety warning triggered inside timer! isEmptyWipe=${isEmptyWipe}, deletionsCount=${this.recentDeletions.length}`,
                );
                this.bulkDeletionWarning = true;
                await this.pause();

                const msg = isEmptyWipe
                  ? "Local sync folder was emptied. Synchronization paused to protect remote cloud files."
                  : `Bulk deletion of ${this.recentDeletions.length} files detected. Synchronization paused.`;

                this.db.log("system", "system", "failed", msg);
                this.emit("statusChanged");
                return;
              }

              // Remove from pending and execute
              this.pendingLocalDeletes.delete(relativePath);
              if (!this.activeReconciles.has(relativePath)) {
                await this.deleteRemoteNode(pending.nodeUid, relativePath);
              }
            }
          }, 2500);
        }
      }
      this.emit("statusChanged");
    } catch (err: any) {
      this.logger.error(
        `Failed to handle local change at ${relativePath}:`,
        err,
      );
      this.db.log(
        relativePath,
        "system",
        "failed",
        `Watcher error: ${err.message || err}`,
      );
    }
  }

  // Subscribe to remote events
  private async subscribeToRemoteEvents(scopeId: string) {
    if (this.remoteSubscription) return;

    this.logger.info(`Subscribing to remote events for scope ${scopeId}`);

    this.remoteSubscription = await this.sdk.subscribeToTreeEvents(
      scopeId,
      async (event: DriveEvent) => {
        if (this.isPaused) return;

        try {
          this.logger.info(`Received remote event type: ${event.type}`);
          await this.handleRemoteEvent(event);
          if (this.eventsProvider) {
            await this.eventsProvider.setLatestEventId(
              "drive",
              scopeId,
              event.eventId,
            );
          }
          this.emit("statusChanged");
        } catch (err: any) {
          this.logger.error("Failed to handle remote event:", err);
        }
      },
    );

    const latestEventId = this.remoteSubscription.getLatestEventId();
    if (latestEventId && this.eventsProvider) {
      this.logger.debug(
        `Subscribed to scope drive:${scopeId} with latest event ID ${latestEventId}`,
      );
      await this.eventsProvider.setLatestEventId(
        "drive",
        scopeId,
        latestEventId,
      );
    }
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
        this.logger.info(
          `Remote node deleted, deleting local path: ${mapped.local_path}`,
        );
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
        this.logger.info(
          `Remote node trashed, deleting local path: ${mapped.local_path}`,
        );
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
      .map((n) => (n.name.ok ? n.name.value : ""))
      .join("/");

    if (!relativePath) return;

    // Process remote created or updated event (skip if a reconcile is already handling this path)
    if (this.activeReconciles.has(relativePath)) {
      this.logger.debug(
        `Remote event for ${relativePath} deferred — reconcile already in progress`,
      );
      return;
    }
    if (
      this.activeTransfers.has(relativePath) ||
      this.activeDownloads.has(relativePath)
    ) {
      this.logger.debug(
        `Remote event for ${relativePath} deferred — active transfer in progress`,
      );
      return;
    }
    await this.syncRemoteToLocal(relativePath, node);
  }

  // Synchronization operations: Sync Local -> Remote
  private async syncLocalToRemote(
    relativePath: string,
    isDir: boolean,
  ): Promise<void> {
    const localPath = this.resolveLocalPath(relativePath);
    if (!existsSync(localPath)) return;

    this.activeTransfers.set(relativePath, {
      type: "upload",
      size: 0,
      transferred: 0,
    });
    this.emit("statusChanged");
    this.db.log(
      relativePath,
      "upload",
      "syncing",
      "Uploading local file/folder",
    );

    try {
      if (isDir) {
        await this.runWithRetry(async () => {
          const stat = statSync(localPath);

          // Ensure parent exists remotely and get its UID
          const parts = relativePath.split("/");
          const folderName = parts.pop()!;
          const parentRelPath = parts.join("/");
          const parentUid = parentRelPath
            ? await this.ensureRemoteParentFolder(parentRelPath)
            : this.remoteRootUid;

          // Create directory remotely
          let nodeUid = "";
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
            sha1: "",
            remote_revision_uid: "",
            remote_mtime: stat.mtimeMs,
          });

          this.db.log(
            relativePath,
            "upload",
            "completed",
            "Local folder mapped to remote",
          );
        });
      } else {
        // It is a file upload
        const stat = statSync(localPath);
        const size = stat.size;
        const mtime = stat.mtimeMs;
        const sha1 = await getSha1(localPath);

        const file = Bun.file(localPath);
        const metadata = {
          mediaType: file.type || "application/octet-stream",
          expectedSize: size,
          expectedSha1: sha1,
          modificationTime: new Date(mtime),
        };

        const mapped = this.db.getMapping(relativePath);
        if (mapped && size === mapped.size && sha1 === mapped.sha1) {
          this.logger.info(
            `Skipping duplicate upload for ${relativePath} - content is unchanged.`,
          );
          if (mtime !== mapped.mtime) {
            this.db.setMapping({
              ...mapped,
              mtime,
              remote_mtime: mtime,
            });
          }
          this.activeTransfers.delete(relativePath);
          this.emit("statusChanged");
          return;
        }

        // Set file upload details
        this.activeTransfers.set(relativePath, {
          type: "upload",
          size,
          transferred: 0,
        });
        this.emit("statusChanged");

        const progressCallback = (uploadedBytes: number) => {
          const transfer = this.activeTransfers.get(relativePath);
          if (transfer) {
            transfer.transferred = Math.min(uploadedBytes, size);
            this.emit("statusChanged");
          }
        };

        const stream = file.stream();
        this.activeUploads.set(relativePath, {
          abort: async () => {
            try {
              await stream.cancel();
            } catch (e) {}
          },
        });

        const { nodeUid, nodeRevisionUid } = await this.runWithRetry(
          async () => {
            if (this.isPaused || !this.isStarted) {
              throw new Error("Sync paused or stopped");
            }
            let uploadController;
            if (mapped) {
              this.logger.info(
                `Uploading file revision for ${relativePath} (${mapped.node_uid})`,
              );
              const uploader = await this.sdk.getFileRevisionUploader(
                mapped.node_uid,
                metadata,
              );
              uploadController = await uploader.uploadFromStream(
                stream,
                [],
                progressCallback,
              );
            } else {
              // Upload new file: ensure remote parent directory exists first
              const parts = relativePath.split("/");
              const fileName = parts.pop()!;
              const parentRelPath = parts.join("/");
              const parentUid = parentRelPath
                ? await this.ensureRemoteParentFolder(parentRelPath)
                : this.remoteRootUid;

              this.logger.info(
                `Uploading new file ${fileName} under parent ${parentUid}`,
              );
              const uploader = await this.sdk.getFileUploader(
                parentUid,
                fileName,
                metadata,
              );
              uploadController = await uploader.uploadFromStream(
                stream,
                [],
                progressCallback,
              );
            }

            return await uploadController.completion();
          },
        );

        // Verify if it was deleted locally during the upload
        if (!existsSync(localPath)) {
          this.logger.warn(
            `File ${relativePath} was deleted locally during upload. Trashing remote node.`,
          );
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

        this.db.log(
          relativePath,
          "upload",
          "completed",
          "Uploaded successfully",
        );
      }
    } catch (err: any) {
      this.logger.error(`Upload failed for ${relativePath}:`, err);
      this.db.log(
        relativePath,
        "upload",
        "failed",
        `Upload error: ${err.message || err}`,
      );
      throw err;
    } finally {
      this.activeUploads.delete(relativePath);
      this.activeTransfers.delete(relativePath);
      this.emit("statusChanged");
    }
  }

  // Synchronization operations: Sync Remote -> Local
  private async syncRemoteToLocal(
    relativePath: string,
    node: NodeEntity,
  ): Promise<void> {
    const localPath = this.resolveLocalPath(relativePath);

    // Pre-download check: Detect remote rename/move of folders and files
    const mappedByUid = this.db.getMappingByNodeUid(node.uid);
    if (mappedByUid && mappedByUid.local_path !== relativePath) {
      const oldRelPath = mappedByUid.local_path;
      const oldLocalPath = this.resolveLocalPath(oldRelPath);

      this.logger.info(
        `Detected remote rename/move of node ${node.uid} from ${oldRelPath} to ${relativePath}`,
      );
      this.db.log(
        relativePath,
        "rename_local",
        "completed",
        `Renaming local path from ${oldRelPath}`,
      );

      // Ignore both paths long enough for Chokidar to process the rename event
      this.ignorePathTemporarily(oldLocalPath, 3000);
      this.ignorePathTemporarily(localPath, 3000);
      try {
        if (existsSync(oldLocalPath)) {
          const parentDir = path.dirname(localPath);
          if (!existsSync(parentDir)) {
            mkdirSync(parentDir, { recursive: true });
          }
          await rename(oldLocalPath, localPath);
        }
      } catch (err) {
        this.logger.error(
          `Failed to rename local path from ${oldRelPath} to ${localPath}:`,
          err,
        );
      }

      // Update database mappings for parent folder/file
      this.db.deleteMapping(oldRelPath);
      this.db.setMapping({
        ...mappedByUid,
        local_path: relativePath,
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
              local_path: newChildPath,
            });
          }
        }
      }
    }

    // Guard: Skip downloading if our database mapping matches this exact remote revision
    if (node.type !== NodeType.Folder) {
      const revision = node.activeRevision?.ok
        ? node.activeRevision.value
        : null;
      const mapped = this.db.getMapping(relativePath);
      if (revision && mapped && mapped.remote_revision_uid === revision.uid) {
        this.logger.debug(
          `Skipping download for ${relativePath} - already at remote revision ${revision.uid}`,
        );
        return;
      }
    }

    this.activeTransfers.set(relativePath, {
      type: "download",
      size: 0,
      transferred: 0,
    });
    this.emit("statusChanged");
    this.db.log(
      relativePath,
      "download",
      "syncing",
      "Downloading remote file/folder",
    );

    try {
      if (node.type === NodeType.Folder) {
        await this.runWithRetry(async () => {
          // Ensure directory exists locally
          this.ignorePathTemporarily(localPath, 3000);
          if (!existsSync(localPath)) {
            mkdirSync(localPath, { recursive: true });
          }

          const remoteMtime = node.folder?.claimedModificationTime
            ? new Date(node.folder.claimedModificationTime).getTime()
            : node.modificationTime.getTime();

          this.db.setMapping({
            local_path: relativePath,
            node_uid: node.uid,
            is_dir: 1,
            size: 0,
            mtime: remoteMtime,
            sha1: "",
            remote_revision_uid: "",
            remote_mtime: remoteMtime,
          });

          this.db.log(
            relativePath,
            "download",
            "completed",
            "Remote folder mapped to local directory",
          );
        });
      } else {
        // Download file
        const revision = node.activeRevision?.ok
          ? node.activeRevision.value
          : null;
        if (!revision) {
          throw new Error("Remote file has no active revision");
        }

        // Check if directory containing file exists locally
        const parentLocalPath = path.dirname(localPath);
        this.ignorePathTemporarily(parentLocalPath, 3000);
        if (!existsSync(parentLocalPath)) {
          mkdirSync(parentLocalPath, { recursive: true });
        }

        const tmpPath = `${localPath}.tmp-${Date.now()}`;

        this.ignoredLocalChanges.add(tmpPath);
        const bunFile = Bun.file(tmpPath);
        const writer = bunFile.writer();
        const writableStream = {
          getWriter: () => writer,
          close: async () => {
            await writer.end();
          },
          abort: async () => {
            try {
              await writer.end();
            } catch (e) {}
            await unlink(tmpPath).catch(() => {});
          },
          locked: false,
        };

        this.activeDownloads.set(relativePath, {
          abort: async () => {
            await writableStream.abort();
          },
        });

        const size = revision.claimedSize ?? 0;
        this.activeTransfers.set(relativePath, {
          type: "download",
          size,
          transferred: 0,
        });
        this.emit("statusChanged");

        const progressCallback = (downloadedBytes: number) => {
          const transfer = this.activeTransfers.get(relativePath);
          if (transfer) {
            transfer.transferred = downloadedBytes;
            this.emit("statusChanged");
          }
        };

        try {
          await this.runWithRetry(async () => {
            if (this.isPaused || !this.isStarted) {
              throw new Error("Sync paused or stopped");
            }
            const downloader = await this.sdk.getFileDownloader(node);
            const downloadController = downloader.downloadToStream(
              writableStream as any,
              progressCallback,
            );
            await downloadController.completion();
          });
          await writer.end();
        } catch (downloadErr) {
          await writableStream.abort();
          throw downloadErr;
        } finally {
          this.activeDownloads.delete(relativePath);
          this.ignoredLocalChanges.delete(tmpPath);
        }

        // Atomically swap the temp file to the final path
        // rename() is O(1) memory and crash-safe (atomic on same filesystem)
        this.ignorePathTemporarily(localPath, 3000);
        await mkdir(path.dirname(localPath), { recursive: true }).catch(
          () => {},
        );
        await rename(tmpPath, localPath);

        // Set modification time locally to match remote
        const remoteMtime = revision.claimedModificationTime
          ? new Date(revision.claimedModificationTime).getTime()
          : revision.creationTime.getTime();

        utimesSync(localPath, new Date(), new Date(remoteMtime));

        // Fetch local stat to verify size/mtime mapping
        const localStat = statSync(localPath);

        // Save mapping
        this.db.setMapping({
          local_path: relativePath,
          node_uid: node.uid,
          is_dir: 0,
          size: localStat.size,
          mtime: localStat.mtimeMs,
          sha1: revision.claimedDigests?.sha1 || "",
          remote_revision_uid: revision.uid,
          remote_mtime: remoteMtime,
        });

        this.db.log(
          relativePath,
          "download",
          "completed",
          "Downloaded successfully",
        );
      }
    } catch (err: any) {
      this.logger.error(`Download failed for ${relativePath}:`, err);
      this.db.log(
        relativePath,
        "download",
        "failed",
        `Download error: ${err.message || err}`,
      );
      throw err;
    } finally {
      this.activeDownloads.delete(relativePath);
      this.activeTransfers.delete(relativePath);
      this.emit("statusChanged");
    }
  }

  // Handles conflicts by downloading the remote as primary and renaming local version
  private async handleConflict(relativePath: string, node: NodeEntity) {
    const localPath = this.resolveLocalPath(relativePath);
    if (!existsSync(localPath)) return;

    const ext = path.extname(relativePath);
    const stem = path.basename(relativePath, ext);
    const parentDir = path.dirname(relativePath);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const conflictRelPath =
      parentDir === "."
        ? `${stem} (Conflict ${timestamp})${ext}`
        : `${parentDir}/${stem} (Conflict ${timestamp})${ext}`;

    const conflictAbsPath = this.resolveLocalPath(conflictRelPath);

    this.logger.warn(
      `Conflict detected at ${relativePath}. Renaming local to ${conflictRelPath}`,
    );
    this.db.log(
      relativePath,
      "system",
      "syncing",
      `Conflict detected. Renaming local to: ${path.basename(conflictRelPath)}`,
    );

    // Rename local file to conflict path
    this.ignoredLocalChanges.add(localPath);
    this.ignoredLocalChanges.add(conflictAbsPath);
    await Bun.write(conflictAbsPath, Bun.file(localPath));
    await unlink(localPath);
    this.ignorePathTemporarily(localPath, 2500);
    this.ignorePathTemporarily(conflictAbsPath, 2500);

    // Upload the renamed conflict copy as a new file
    await this.syncLocalToRemote(conflictRelPath, false);

    // Download the remote file to the original path
    await this.syncRemoteToLocal(relativePath, node);
  }

  // Helper: ensuring remote folders exist along a path
  private async ensureRemoteParentFolder(
    parentRelativePath: string,
  ): Promise<string> {
    return await this.runWithRetry(async () => {
      const parts = parentRelativePath.split("/");
      let currentParentUid = this.remoteRootUid;
      let prefix = "";

      for (const part of parts) {
        prefix = prefix ? `${prefix}/${part}` : part;
        const mapped = this.db.getMapping(prefix);

        if (mapped) {
          currentParentUid = mapped.node_uid;
        } else {
          // Check if there is an active folder creation promise for this prefix
          let creationPromise = this.activeFolderCreations.get(prefix);
          if (!creationPromise) {
            creationPromise = (async () => {
              // Double check database in case it was mapped while waiting
              const doubleCheckMapped = this.db.getMapping(prefix);
              if (doubleCheckMapped) {
                return doubleCheckMapped.node_uid;
              }

              // Check if directory already exists remotely but isn't mapped yet (batch lookups)
              let foundUid = "";
              const childUids: string[] = [];
              for await (const uid of this.sdk.iterateFolderChildrenNodeUids(
                currentParentUid,
              )) {
                childUids.push(uid);
              }
              outer: for (let ci = 0; ci < childUids.length; ci += 50) {
                const chunk = childUids.slice(ci, ci + 50);
                for await (const childNode of this.sdk.iterateNodes(chunk)) {
                  if ("missingUid" in childNode) continue;
                  if (
                    childNode.type === NodeType.Folder &&
                    !childNode.trashTime &&
                    childNode.name.ok &&
                    childNode.name.value === part
                  ) {
                    foundUid = childNode.uid;
                    break outer;
                  }
                }
              }

              let nodeUid = "";
              if (foundUid) {
                nodeUid = foundUid;
              } else {
                // Create remote directory
                try {
                  const node = await this.sdk.createFolder(
                    currentParentUid,
                    part,
                  );
                  nodeUid = node.uid;
                } catch (err: any) {
                  // If directory already exists, grab its UID
                  if (err.existingNodeUid) {
                    nodeUid = err.existingNodeUid;
                  } else {
                    throw err;
                  }
                }
              }

              // Try to get actual local filesystem mtime if it exists
              let folderMtime = Date.now();
              try {
                const localFolderAbsPath = this.resolveLocalPath(prefix);
                if (existsSync(localFolderAbsPath)) {
                  folderMtime = statSync(localFolderAbsPath).mtimeMs;
                }
              } catch (e) {}

              // Map folder in db
              this.db.setMapping({
                local_path: prefix,
                node_uid: nodeUid,
                is_dir: 1,
                size: 0,
                mtime: folderMtime,
                sha1: "",
                remote_revision_uid: "",
                remote_mtime: folderMtime,
              });

              return nodeUid;
            })();

            this.activeFolderCreations.set(prefix, creationPromise);
          }

          try {
            currentParentUid = await creationPromise;
          } finally {
            this.activeFolderCreations.delete(prefix);
          }
        }
      }

      return currentParentUid;
    });
  }

  private async deleteRemoteNode(
    nodeUid: string,
    relativePath: string,
  ): Promise<void> {
    const mapped = this.db.getMapping(relativePath);
    const isDir = mapped ? mapped.is_dir === 1 : false;

    this.db.log(
      relativePath,
      "delete_remote",
      "syncing",
      "Deleting file from cloud",
    );
    try {
      await this.runWithRetry(async () => {
        for await (const result of this.sdk.trashNodes([nodeUid])) {
          if (!result.ok) throw result.error;
        }
      });
      this.db.deleteMapping(relativePath);

      // If it is a directory, recursively delete child mappings in the database
      if (isDir) {
        const allMappings = this.db.getAllMappings();
        for (const m of allMappings) {
          if (m.local_path.startsWith(`${relativePath}/`)) {
            this.db.deleteMapping(m.local_path);
          }
        }
      }

      this.db.log(
        relativePath,
        "delete_remote",
        "completed",
        "Cloud file moved to trash",
      );
    } catch (err: any) {
      this.logger.error(`Failed to delete remote node ${nodeUid}:`, err);
      this.db.log(
        relativePath,
        "delete_remote",
        "failed",
        `Remote delete error: ${err.message || err}`,
      );
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

    this.db.log(relativePath, "delete_local", "syncing", "Deleting local file");
    this.ignoredLocalChanges.add(localPath);
    try {
      await rm(localPath, { recursive: true, force: true });
      this.db.deleteMapping(relativePath);
      this.db.log(
        relativePath,
        "delete_local",
        "completed",
        "Deleted local file",
      );
    } catch (err: any) {
      this.logger.error(`Failed to delete local file ${relativePath}:`, err);
      this.db.log(
        relativePath,
        "delete_local",
        "failed",
        `Local delete error: ${err.message || err}`,
      );
      throw err;
    } finally {
      this.ignorePathTemporarily(localPath, 2500);
    }
  }

  private resolveLocalPath(relativePath: string): string {
    return path.join(this.localSyncRoot, relativePath);
  }

  getBulkDeletionCount(): number {
    return this.recentDeletions.length;
  }

  async confirmBulkDeletions(): Promise<void> {
    this.logger.info("User confirmed bulk deletions. Resuming sync.");
    this.isBulkDeletionConfirmed = true;
    this.bulkDeletionWarning = false;
    this.recentDeletions = [];

    // Process all pending deletions that were paused
    const pendingDeletes = Array.from(this.pendingLocalDeletes.entries());
    this.pendingLocalDeletes.clear();
    for (const [relPath, pending] of pendingDeletes) {
      try {
        // Check if any ancestor is also in the list of pending deletes
        let ancestorPending = false;
        const parts = relPath.split("/");
        let current = "";
        for (let i = 0; i < parts.length - 1; i++) {
          current = current ? `${current}/${parts[i]}` : parts[i];
          if (pendingDeletes.some(([p]) => p === current)) {
            ancestorPending = true;
            break;
          }
        }

        if (ancestorPending) {
          this.db.deleteMapping(relPath);
        } else {
          if (!this.activeReconciles.has(relPath)) {
            await this.deleteRemoteNode(pending.nodeUid, relPath);
          }
        }
      } catch (err) {
        this.logger.error(
          `Failed to execute confirmed deletion for ${relPath}:`,
          err,
        );
      }
    }

    await this.resume();
  }

  async restoreBulkDeletions(): Promise<void> {
    this.logger.info(
      "User rejected bulk deletions. Restoring local files from remote cloud.",
    );
    this.bulkDeletionWarning = false;
    this.recentDeletions = [];
    this.db.clearMappings();
    await this.resume();
  }

  private async runWithRetry<T>(
    fn: () => Promise<T>,
    retries = 5,
    initialDelay = 1000,
  ): Promise<T> {
    let delay = initialDelay;
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (error: any) {
        const isNetworkError = this.isNetworkError(error);
        this.logger.warn(
          `Operation failed (attempt ${i + 1}/${retries}). Error: ${error.message || error}. NetworkError=${isNetworkError}`,
        );

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
    throw new Error("Unreachable retry loop state");
  }

  private isNetworkError(error: any): boolean {
    const msg = (error.message || "").toLowerCase();
    const code = error.code || "";
    return (
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "EHOSTUNREACH" ||
      code === "ENETUNREACH" ||
      code === "ECONNREFUSED" ||
      msg.includes("fetch failed") ||
      msg.includes("network error") ||
      msg.includes("timeout") ||
      msg.includes("offline")
    );
  }

  private startOfflineMonitor(): void {
    if (this.offlineMonitorPromise) return; // Singleton guard — immune to concurrent calls from multiple failing workers

    this.logger.warn("Network offline detected. Starting connection monitor.");
    this.db.log(
      "system",
      "system",
      "failed",
      "Network offline. Synchronization paused until connection is restored.",
    );
    this.isOffline = true;
    this.emit("statusChanged");

    this.offlineMonitorPromise = this.runOfflineMonitor().finally(() => {
      this.offlineMonitorPromise = null;
    });
  }

  private async runOfflineMonitor(): Promise<void> {
    while (true) {
      await new Promise<void>((resolve) => setTimeout(resolve, 15000));
      if (!this.isStarted) return; // Engine was stopped while offline
      if (!this.isOffline) return; // Already marked online by listener event
      try {
        this.logger.debug("Checking connection state...");
        await this.sdk.getMyFilesRootFolder();
        this.handleOnlineEvent();
        return;
      } catch {
        // Still offline — loop again
        this.logger.debug("Connection check failed, still offline.");
      }
    }
  }

  private handleOnlineEvent(): void {
    if (!this.isStarted || !this.isOffline) return;
    this.logger.info("Connection restored!");
    this.db.log(
      "system",
      "system",
      "completed",
      "Network connection restored. Resuming synchronization.",
    );

    this.isOffline = false;
    this.emit("statusChanged");
  }

  private ignorePathTemporarily(absolutePath: string, durationMs = 2500) {
    this.ignoredLocalChanges.add(absolutePath);
    setTimeout(() => {
      this.ignoredLocalChanges.delete(absolutePath);
    }, durationMs);
  }

  /** Removes orphaned .tmp-* files left by a previous crash during download */
  private async cleanupTempFiles(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      await Promise.all(
        entries.map(async (entry) => {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await this.cleanupTempFiles(fullPath);
          } else if (/\.tmp-\d+$/.test(entry.name)) {
            this.logger.warn(`Removing orphaned temp file: ${entry.name}`);
            await unlink(fullPath).catch(() => {});
          }
        }),
      );
    } catch (err) {
      this.logger.warn(`Failed to clean temp files in ${dir}:`, err);
    }
  }

  /** 60-second liveness check — detects sleep/resume and dead remote subscriptions */
  private startLivenessMonitor(): void {
    if (this.livenessInterval) return;
    this.livenessInterval = setInterval(async () => {
      if (this.isOffline || this.isPaused || !this.isStarted) return;
      try {
        await this.sdk.getMyFilesRootFolder();
      } catch (err) {
        if (this.isNetworkError(err)) {
          this.logger.warn(
            "Liveness check failed — triggering offline monitor.",
          );
          this.startOfflineMonitor();
        }
      }
    }, 60_000);
  }
}
