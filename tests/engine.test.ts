import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { SyncEngine } from "../src/sync/engine";
import { SyncDatabase } from "../src/sync/db";
import { DriveEventType } from "@protontech/drive-sdk";
import { existsSync, unlinkSync, rmSync, mkdirSync, writeFileSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

mock.module("chokidar", () => {
    return {
        default: {
            watch: mock().mockReturnValue({
                on: mock().mockReturnThis(),
                close: mock().mockResolvedValue(undefined),
                getWatched: mock().mockReturnValue({}),
            }),
        },
    };
});

describe("SyncEngine", () => {
    let db: SyncDatabase;
    let dbPath: string;
    let syncRoot: string;
    let mockSdk: any;
    let mockAuth: any;
    let mockEventsManager: any;

    beforeEach(() => {
        dbPath = path.join(tmpdir(), `test-engine-${Date.now()}-${Math.random()}.db`);
        db = new SyncDatabase(dbPath);

        syncRoot = path.join(tmpdir(), `test-sync-root-${Date.now()}`);
        mkdirSync(syncRoot, { recursive: true });

        mockSdk = {
            getMyFilesRootFolder: mock().mockResolvedValue({ uid: "root-uid" }),
            iterateFolderChildren: async function* () { },
            iterateFolderChildrenNodeUids: async function* () { },
            getNode: mock().mockResolvedValue({ 
                uid: "node-uid", 
                name: { ok: true, value: "test" }, 
                modificationTime: new Date(), 
                creationTime: new Date(), 
                size: 100, 
                type: 1, 
                mimeType: "text/plain" 
            }),
            getFileUploader: mock().mockResolvedValue({
                uploadFromStream: mock().mockResolvedValue({
                    completion: mock().mockResolvedValue({ nodeUid: "new-node-uid", nodeRevisionUid: "rev-uid" })
                })
            }),
            getFileRevisionUploader: mock().mockResolvedValue({
                uploadFromStream: mock().mockResolvedValue({
                    completion: mock().mockResolvedValue({ nodeUid: "new-node-uid", nodeRevisionUid: "rev-uid" })
                })
            }),
            getFileDownloader: mock().mockResolvedValue({
                downloadToStream: mock().mockReturnValue({
                    completion: mock().mockResolvedValue(undefined)
                })
            }),
            iterateNodes: async function* (uids: string[]) {
                for (const uid of uids) {
                    if (uid === "remote-uid") {
                        yield { 
                            uid: "remote-uid", 
                            name: { ok: true, value: "remote.txt" }, 
                            modificationTime: new Date(), 
                            creationTime: new Date(), 
                            size: 100, 
                            type: 1, 
                            mimeType: "text/plain",
                            activeRevision: { ok: true, value: { id: "rev-123", state: 1, claimedModificationTime: Date.now(), creationTime: new Date() } }
                        };
                    }
                }
            },
            experimental: {
                processCoreEvent: mock(),
            },
            renameNode: mock().mockResolvedValue({}),
            moveNodes: async function* () { yield { uid: "moved", success: true }; },
            trashNodes: async function* () { yield { uid: "trashed", success: true }; },
            createFolder: mock().mockResolvedValue({ uid: "new-folder-uid" })
        };

        mockAuth = {
            isLoggedIn: mock().mockReturnValue(true)
        };

        mockEventsManager = {
            on: mock(),
            off: mock(),
            start: mock().mockResolvedValue(undefined),
            stop: mock().mockResolvedValue(undefined),
            getLatestEventId: mock().mockResolvedValue(null),
            setLatestEventId: mock().mockResolvedValue(undefined),
        };
    });

    afterEach(() => {
        db.close();
        try { unlinkSync(dbPath); } catch {}
        try { unlinkSync(`${dbPath}-wal`); } catch {}
        try { unlinkSync(`${dbPath}-shm`); } catch {}
        try { rmSync(syncRoot, { recursive: true, force: true }); } catch {}
    });

    it("should initialize correctly", () => {
        const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: console.error, debug: mock() }, mockEventsManager);
        expect(engine.getStatus()).toBe("idle");
    });

    it("should set and get local sync root", async () => {
        const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: console.error, debug: mock() }, mockEventsManager);
        await engine.setLocalSyncRoot(syncRoot);
        expect(engine.getLocalSyncRoot()).toBe(syncRoot);
    });

    describe("startupSync", () => {
        it("should trigger forceSync if full_sync_completed is 0 even when mappings exist", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: console.error, debug: mock() }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);
            
            db.setMapping({
                local_path: "file.txt",
                node_uid: "uid-1",
                is_dir: 0,
                size: 10,
                mtime: Date.now(),
                sha1: "abc",
                remote_revision_uid: "rev-1",
                remote_mtime: Date.now(),
            });
            expect(db.getConfig("full_sync_completed", "0")).toBe("0");

            let forceSyncCalled = false;
            engine.forceSync = async () => { forceSyncCalled = true; };

            await engine.startupSync();
            expect(forceSyncCalled).toBe(true);
        });

        it("should trigger fastSync if full_sync_completed is 1", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: console.error, debug: mock() }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);
            
            db.setMapping({
                local_path: "file.txt",
                node_uid: "uid-1",
                is_dir: 0,
                size: 10,
                mtime: Date.now(),
                sha1: "abc",
                remote_revision_uid: "rev-1",
                remote_mtime: Date.now(),
            });
            db.setConfig("full_sync_completed", "1");
            db.setConfig("full_sync_in_progress", "0");
            db.setConfig("last_successful_sync_at", String(Date.now()));
            db.setConfig("event_cursor_safety_version", "1");

            let fastSyncCalled = false;
            engine.fastSync = async () => { fastSyncCalled = true; };

            await engine.startupSync();
            expect(fastSyncCalled).toBe(true);
        });

        it("should run a one-time full scan for pre-journal event cursors", async () => {
            const engine = new SyncEngine(
                db,
                mockSdk,
                mockAuth,
                { info: mock(), warn: mock(), error: mock(), debug: mock() },
                mockEventsManager,
            );
            await engine.setLocalSyncRoot(syncRoot);
            db.setMapping({
                local_path: "mapped.txt",
                node_uid: "mapped-node",
                is_dir: 0,
                size: 1,
                mtime: Date.now(),
                sha1: "",
                remote_revision_uid: "revision",
                remote_mtime: Date.now(),
            });
            db.setConfig("full_sync_completed", "1");
            db.setConfig("full_sync_in_progress", "0");
            db.setConfig("last_successful_sync_at", String(Date.now()));
            let fullSyncCalled = false;
            engine.forceSync = async () => {
                fullSyncCalled = true;
            };

            await engine.startupSync();

            expect(fullSyncCalled).toBe(true);
        });

        it("should resume an interrupted full sync after restart even when an older pass completed", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: console.error, debug: mock() }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);

            db.setMapping({
                local_path: "file.txt",
                node_uid: "node-1",
                is_dir: 0,
                size: 1,
                mtime: Date.now(),
                sha1: "abc",
                remote_revision_uid: "rev-1",
                remote_mtime: Date.now(),
            });
            db.setConfig("full_sync_completed", "1");
            db.setConfig("full_sync_in_progress", "1");

            let forceSyncCalled = false;
            let fastSyncCalled = false;
            engine.forceSync = async () => { forceSyncCalled = true; };
            engine.fastSync = async () => { fastSyncCalled = true; };

            await engine.startupSync();

            expect(forceSyncCalled).toBe(true);
            expect(fastSyncCalled).toBe(false);
        });

        it("should execute fresh initial sync end-to-end when starting clean", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: console.error, debug: mock() }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);
            
            // Clean database state
            expect(db.getMappingCount()).toBe(0);
            expect(db.getConfig("full_sync_completed", "0")).toBe("0");

            // Mock empty remote folder
            mockSdk.iterateFolderChildrenNodeUids = async function* () { };

            // Create 1 local file
            writeFileSync(path.join(syncRoot, "fresh.txt"), "fresh initial sync content");

            (engine as any).isStarted = true;

            // Run startupSync on fresh database
            await engine.startupSync();

            // Assert DB mapping created and full_sync_completed set to 1
            expect(db.getMappingCount()).toBe(1);
            expect(db.getMapping("fresh.txt")).toBeDefined();
            expect(db.getConfig("full_sync_completed", "0")).toBe("1");
        });
    });

    describe("postSyncCleanup & temp file safety", () => {
        it("should remove stale daemon download temp files older than 2 mins", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: console.error, debug: mock() }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);

            const fiveMinsAgoTs = Date.now() - 300_000;
            const staleTemp = path.join(syncRoot, `archive.tar.tmp-${fiveMinsAgoTs}`);
            writeFileSync(staleTemp, "stale temp content");
            const fiveMinsAgo = new Date(fiveMinsAgoTs);
            utimesSync(staleTemp, fiveMinsAgo, fiveMinsAgo);

            await (engine as any).postSyncCleanup();
            expect(existsSync(staleTemp)).toBe(false);
        });

        it("should preserve regular user files named *.tmp", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: console.error, debug: mock() }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);

            const userTmp = path.join(syncRoot, "user_notes.tmp");
            writeFileSync(userTmp, "user notes content");
            const fiveMinsAgo = new Date(Date.now() - 300_000);
            utimesSync(userTmp, fiveMinsAgo, fiveMinsAgo);

            await (engine as any).postSyncCleanup();
            expect(existsSync(userTmp)).toBe(true);
        });

        it("should preserve recent temp files modified within 2 mins", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: console.error, debug: mock() }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);

            const recentTemp = path.join(syncRoot, `recent.tar.tmp-${Date.now()}`);
            writeFileSync(recentTemp, "recent temp content");

            await (engine as any).postSyncCleanup();
            expect(existsSync(recentTemp)).toBe(true);
        });
    });

    describe("forceSync", () => {
        it("should perform initial scan and finish", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { 
                info: mock(), 
                warn: mock(), 
                error: (msg: any, err?: any) => console.error(msg, err), 
                debug: mock() 
            }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);
            
            // Mock empty remote tree
            mockSdk.iterateFolderChildrenNodeUids = async function* () { };

            await engine.forceSync();
            expect(engine.getStatus()).toBe("idle");
            expect(db.getConfig("full_sync_in_progress", "1")).toBe("0");
        });

        it("should persist an unfinished full scan so the next process retries it", async () => {
            const engine = new SyncEngine(
                db,
                mockSdk,
                mockAuth,
                { info: mock(), warn: mock(), error: mock(), debug: mock() },
                mockEventsManager,
            );
            await engine.setLocalSyncRoot(syncRoot);
            db.setConfig("full_sync_completed", "1");
            (engine as any).remoteRootUid = "root-uid";
            (engine as any).scanRemoteDir = async () => {
                expect(db.getConfig("full_sync_in_progress", "0")).toBe("1");
                throw new Error("interrupted metadata scan");
            };

            await engine.forceSync();

            expect(db.getConfig("full_sync_completed", "0")).toBe("1");
            expect(db.getConfig("full_sync_in_progress", "0")).toBe("1");
        });

        it("should retry an interrupted full scan after the network reconnects", async () => {
            const engine = new SyncEngine(
                db,
                mockSdk,
                mockAuth,
                { info: mock(), warn: mock(), error: mock(), debug: mock() },
                mockEventsManager,
            );
            await engine.setLocalSyncRoot(syncRoot);
            (engine as any).isStarted = true;
            (engine as any).remoteRootUid = "root-uid";

            let remoteScanAttempts = 0;
            (engine as any).scanRemoteDir = async () => {
                remoteScanAttempts++;
                if (remoteScanAttempts === 1) {
                    throw new TypeError("fetch failed");
                }
            };
            // Avoid the monitor's real 15-second timer; this test drives the
            // same offline/online transition directly.
            (engine as any).startOfflineMonitor = () => {
                (engine as any).isOffline = true;
            };

            await engine.forceSync();
            expect(engine.getStatus()).toBe("offline");
            expect(remoteScanAttempts).toBe(1);

            (engine as any).handleOnlineEvent();
            expect(["error", "scanning"]).toContain(engine.getStatus());
            await (engine as any).reconnectReconciliationPromise;

            expect(remoteScanAttempts).toBe(2);
            expect(engine.getStatus()).toBe("synced");
            expect(
                db.getRecentLogs(20).some((entry) =>
                    entry.message.includes("Retrying interrupted synchronization"),
                ),
            ).toBe(true);
        });

        it("should report an error instead of synced after a non-network scan failure", async () => {
            const engine = new SyncEngine(
                db,
                mockSdk,
                mockAuth,
                { info: mock(), warn: mock(), error: mock(), debug: mock() },
                mockEventsManager,
            );
            await engine.setLocalSyncRoot(syncRoot);
            (engine as any).isStarted = true;
            (engine as any).remoteRootUid = "root-uid";
            (engine as any).scanRemoteDir = async () => {
                throw new Error("remote metadata is invalid");
            };

            await engine.forceSync();

            expect(engine.getStatus()).toBe("error");
        });

        it("should not mark a pass complete when a transfer worker detected an outage", async () => {
            const engine = new SyncEngine(
                db,
                mockSdk,
                mockAuth,
                { info: mock(), warn: mock(), error: mock(), debug: mock() },
                mockEventsManager,
            );
            await engine.setLocalSyncRoot(syncRoot);
            (engine as any).isStarted = true;
            (engine as any).remoteRootUid = "root-uid";
            (engine as any).scanRemoteDir = async () => {};
            (engine as any).reconcile = async () => {
                // Transfer workers intentionally catch their individual errors.
                // The offline state must still make the overall pass fail.
                (engine as any).isOffline = true;
                (engine as any).reconciliationRetryPending = true;
            };
            (engine as any).startOfflineMonitor = () => {
                (engine as any).isOffline = true;
            };

            await engine.forceSync();

            expect(engine.getStatus()).toBe("offline");
            expect(db.getConfig("full_sync_completed", "0")).toBe("0");
            expect(
                db.getRecentLogs(20).some((entry) =>
                    entry.message.includes("Synchronization was interrupted"),
                ),
            ).toBe(true);
        });

        it("should keep a full scan incomplete when one path fails permanently", async () => {
            const engine = new SyncEngine(
                db,
                mockSdk,
                mockAuth,
                { info: mock(), warn: mock(), error: mock(), debug: mock() },
                mockEventsManager,
            );
            await engine.setLocalSyncRoot(syncRoot);
            writeFileSync(path.join(syncRoot, "failed.txt"), "local content");
            (engine as any).isStarted = true;
            mockSdk.getFileUploader = mock().mockResolvedValue({
                uploadFromStream: mock().mockResolvedValue({
                    completion: mock().mockRejectedValue(
                        Object.assign(new Error("permanent upload failure"), {
                            name: "ValidationError",
                        }),
                    ),
                }),
            });

            await engine.forceSync();

            expect(db.getConfig("full_sync_in_progress", "0")).toBe("1");
            expect(engine.getStatus()).toBe("error");
            expect(
                db.getRecentLogs(30).some(
                    (entry) =>
                        entry.status === "completed" &&
                        entry.message === "Full synchronization complete",
                ),
            ).toBe(false);
        });

        it("should upload local files that are not on remote", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: console.error, debug: mock() }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);
            
            // Create a local file
            writeFileSync(path.join(syncRoot, "local.txt"), "hello world");
            
            (engine as any).isStarted = true;
            
            // Run sync
            await engine.forceSync();
            console.log("DB LOGS:", db.getRecentLogs(20));
            
            // Should have uploaded the file
            expect(mockSdk.getFileUploader).toHaveBeenCalled();
            expect(mockSdk.getFileUploader).toHaveBeenCalledWith(
                "root-uid",
                "local.txt",
                expect.objectContaining({ mediaType: "text/plain" }),
            );
            const mapping = db.getMapping("local.txt");
            expect(mapping).toBeDefined();
            expect(mapping?.node_uid).toBe("new-node-uid");
            expect(existsSync(path.join(syncRoot, ".proton-drive-staging"))).toBe(false);
        });

        it("should recover when lazy file creation reports an existing remote node", async () => {
            const engine = new SyncEngine(
                db,
                mockSdk,
                mockAuth,
                { info: mock(), warn: mock(), error: mock(), debug: mock() },
                mockEventsManager,
            );
            await engine.setLocalSyncRoot(syncRoot);
            writeFileSync(path.join(syncRoot, "existing.txt"), "local content");
            (engine as any).isStarted = true;
            mockSdk.getFileUploader = mock().mockResolvedValue({
                uploadFromStream: mock().mockResolvedValue({
                    completion: mock().mockRejectedValue(
                        Object.assign(new Error("name already exists"), {
                            existingNodeUid: "existing-node",
                        }),
                    ),
                }),
            });

            await engine.forceSync();

            expect(mockSdk.getFileRevisionUploader).toHaveBeenCalledWith(
                "existing-node",
                expect.anything(),
            );
            expect(db.getConfig("full_sync_in_progress", "1")).toBe("0");
        });

        it("should download remote files that are not local", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: console.error, debug: mock() }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);
            
            // Mock remote file
            mockSdk.iterateFolderChildrenNodeUids = async function* () { yield "remote-uid"; };
            mockSdk.getNode = mock().mockResolvedValue({ 
                uid: "remote-uid", 
                name: "remote.txt", 
                ModifyTime: Date.now() / 1000, 
                Size: 100, 
                Type: 1, 
                MIMEType: "text/plain",
                ActiveRevision: { ID: "rev-123" }
            });

            (engine as any).isStarted = true;
            await engine.forceSync();
            
            // Should have called download
            expect(mockSdk.getFileDownloader).toHaveBeenCalled();
            const mapping = db.getMapping("remote.txt");
            expect(mapping).toBeDefined();
            expect(mapping?.node_uid).toBe("remote-uid");
        });

        it("should reject download and retry if downloaded size does not match claimedSize", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: console.error, debug: mock() }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);

            mockSdk.iterateFolderChildrenNodeUids = async function* () { yield "mismatch-uid"; };
            mockSdk.getNode = mock().mockResolvedValue({
                uid: "mismatch-uid",
                name: "mismatch.txt",
                ModifyTime: Date.now() / 1000,
                Size: 9999,
                Type: 1,
                MIMEType: "text/plain",
                ActiveRevision: { ID: "rev-mismatch", claimedSize: 9999 }
            });

            (engine as any).isStarted = true;
            try {
                await engine.forceSync();
            } catch {}

            const mapping = db.getMapping("mismatch.txt");
            expect(mapping).toBeFalsy();
        });

        it("should reject download and retry if SHA-1 checksum mismatches claimedSha1", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: console.error, debug: mock() }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);

            mockSdk.iterateFolderChildrenNodeUids = async function* () { yield "checksum-uid"; };
            mockSdk.getNode = mock().mockResolvedValue({
                uid: "checksum-uid",
                name: "checksum.txt",
                ModifyTime: Date.now() / 1000,
                Size: 0,
                Type: 1,
                MIMEType: "text/plain",
                ActiveRevision: { ID: "rev-checksum", claimedSha1: "invalid-sha1-hash-12345" }
            });

            (engine as any).isStarted = true;
            try {
                await engine.forceSync();
            } catch {}

            const mapping = db.getMapping("checksum.txt");
            expect(mapping).toBeFalsy();
        });
    });

    describe("Conflict Resolution & Edge Cases", () => {
        it("should pause when bulk deletion threshold is exceeded", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: console.error, debug: mock() }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);
            
            // Populate DB with 10 mappings
            const nodeUids: string[] = [];
            for (let i = 0; i < 10; i++) {
                db.setMapping({
                    local_path: `file${i}.txt`,
                    node_uid: `uid-${i}`,
                    is_dir: 0,
                    size: 10,
                    mtime: Date.now(),
                    sha1: "",
                    remote_revision_uid: `rev-${i}`,
                    remote_mtime: Date.now()
                });
                nodeUids.push(`uid-${i}`);
            }

            // Simulate remote having these files (so it's a local deletion)
            mockSdk.iterateFolderChildrenNodeUids = async function* () { 
                for (const uid of nodeUids) yield uid; 
            };
            mockSdk.iterateNodes = async function* (uids: string[]) {
                for (const uid of uids) {
                    yield { 
                        uid: uid, 
                        name: { ok: true, value: `file${uid.split('-')[1]}.txt` }, 
                        modificationTime: new Date(), 
                        creationTime: new Date(), 
                        size: 10, 
                        type: 1, 
                        mimeType: "text/plain",
                        activeRevision: { ok: true, value: { id: `rev-${uid.split('-')[1]}`, state: 1, claimedModificationTime: Date.now(), creationTime: new Date() } }
                    };
                }
            };

            // Local folder is empty (0 local files).
            (engine as any).isStarted = true;
            (engine as any).db.setConfig("bulk_deletion_threshold", "5");
            
            await engine.forceSync();

            // Threshold is 5, so it should pause!
            expect(engine.getStatus()).toBe("bulk_deletion_warning");
            expect(engine.getBulkDeletionCount()).toBe(10);
        });
        it("should handle remote update and local update conflict", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: console.error, debug: mock() }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);
            
            // Create local file
            writeFileSync(path.join(syncRoot, "conflict.txt"), "local edits");
            
            // Map it in DB
            db.setMapping({
                local_path: "conflict.txt",
                node_uid: "conflict-uid",
                is_dir: 0,
                size: 5,
                mtime: Date.now() - 10000,
                sha1: "",
                remote_revision_uid: "rev-1",
                remote_mtime: Date.now() - 10000
            });
            
            // Mock remote file with newer revision
            mockSdk.iterateFolderChildrenNodeUids = async function* () { yield "conflict-uid"; };
            mockSdk.getNode = mock().mockResolvedValue({ 
                uid: "conflict-uid", 
                name: { ok: true, value: "conflict.txt" }, 
                modificationTime: new Date(), 
                creationTime: new Date(), 
                size: 20, 
                type: 1, 
                mimeType: "text/plain" 
            });
            mockSdk.iterateNodes = async function* (uids: string[]) {
                for (const uid of uids) {
                    if (uid === "conflict-uid") {
                        yield { 
                            uid: "conflict-uid", 
                            name: { ok: true, value: "conflict.txt" }, 
                            modificationTime: new Date(), 
                            creationTime: new Date(), 
                            size: 20, 
                            type: 1, 
                            mimeType: "text/plain",
                            activeRevision: { ok: true, value: { id: "rev-2", state: 1, claimedModificationTime: Date.now(), creationTime: new Date() } }
                        };
                    }
                }
            };
            
            (engine as any).isStarted = true;
            await engine.forceSync();
            
            // Should have downloaded the new remote file and renamed local file
            expect(mockSdk.getFileDownloader).toHaveBeenCalled();
            const files = readdirSync(syncRoot);
            expect(files.some(f => f.includes("Conflict"))).toBe(true);
        });

        it("should restore locally deleted file if remote has newer revision", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: console.error, debug: mock() }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);
            
            // Map it in DB, but NO local file exists
            db.setMapping({
                local_path: "restore.txt",
                node_uid: "restore-uid",
                is_dir: 0,
                size: 5,
                mtime: Date.now() - 10000,
                sha1: "",
                remote_revision_uid: "rev-1",
                remote_mtime: Date.now() - 10000
            });
            
            // Mock remote file with newer revision
            mockSdk.iterateFolderChildrenNodeUids = async function* () { yield "restore-uid"; };
            mockSdk.iterateNodes = async function* (uids: string[]) {
                for (const uid of uids) {
                    if (uid === "restore-uid") {
                        yield { 
                            uid: "restore-uid", 
                            name: { ok: true, value: "restore.txt" }, 
                            modificationTime: new Date(), 
                            creationTime: new Date(), 
                            size: 20, 
                            type: 1, 
                            mimeType: "text/plain",
                            activeRevision: { ok: true, value: { id: "rev-2", state: 1, claimedModificationTime: Date.now(), creationTime: new Date() } }
                        };
                    }
                }
            };
            
            (engine as any).isStarted = true;
            await engine.forceSync();
            
            // Should have downloaded the file
            expect(mockSdk.getFileDownloader).toHaveBeenCalled();
            expect(existsSync(path.join(syncRoot, "restore.txt"))).toBe(true);
        });
        it("should rename remote directory and update child mappings when local directory is renamed", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: console.error, debug: mock() }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);

            // Set up original directory and child file in DB and local FS
            mkdirSync(path.join(syncRoot, "OldDir"), { recursive: true });
            writeFileSync(path.join(syncRoot, "OldDir", "file.txt"), "hello world");

            db.setMapping({
                local_path: "OldDir",
                node_uid: "dir-uid-1",
                is_dir: 1,
                size: 0,
                mtime: Date.now(),
                sha1: "",
                remote_revision_uid: "",
                remote_mtime: Date.now()
            });

            db.setMapping({
                local_path: "OldDir/file.txt",
                node_uid: "file-uid-1",
                is_dir: 0,
                size: 11,
                mtime: Date.now(),
                sha1: "hash1",
                remote_revision_uid: "rev-1",
                remote_mtime: Date.now()
            });

            // Simulate watcher event for directory rename (unlinkDir OldDir -> addDir NewDir)
            (engine as any).isStarted = true;
            (engine as any).pendingLocalDeletes.set("OldDir", {
                nodeUid: "dir-uid-1",
                isDir: true,
                timeout: setTimeout(() => {}, 10000)
            });

            // Rename locally on disk
            rmSync(path.join(syncRoot, "OldDir"), { recursive: true, force: true });
            mkdirSync(path.join(syncRoot, "NewDir"), { recursive: true });
            writeFileSync(path.join(syncRoot, "NewDir", "file.txt"), "hello world");

            // Trigger handleLocalChange for NewDir
            await (engine as any).handleLocalChange(path.join(syncRoot, "NewDir"), "add", true);

            // Assertions:
            // 1. SDK renameNode should be called for dir-uid-1 with "NewDir"
            expect(mockSdk.renameNode).toHaveBeenCalledWith("dir-uid-1", "NewDir");

            // 2. DB mapping for OldDir should be gone, NewDir should exist
            expect(db.getMapping("OldDir")).toBeNull();
            expect(db.getMapping("NewDir")).toBeDefined();
            expect(db.getMapping("NewDir")?.node_uid).toBe("dir-uid-1");

            // 3. Child DB mapping for OldDir/file.txt should be updated to NewDir/file.txt
            expect(db.getMapping("OldDir/file.txt")).toBeNull();
            expect(db.getMapping("NewDir/file.txt")).toBeDefined();
            expect(db.getMapping("NewDir/file.txt")?.node_uid).toBe("file-uid-1");

            // 4. getFileUploader should NOT have been called for file.txt (no re-uploading)
            expect(mockSdk.getFileUploader).not.toHaveBeenCalled();
        });

        it("should pair a 10-file bulk move without leaving durable deletes or duplicate originals", async () => {
            const engine = new SyncEngine(
                db,
                mockSdk,
                mockAuth,
                { info: mock(), warn: mock(), error: console.error, debug: mock() },
                mockEventsManager,
            );
            await engine.setLocalSyncRoot(syncRoot);
            mkdirSync(path.join(syncRoot, "destination"), { recursive: true });
            db.setMapping({
                local_path: "destination",
                node_uid: "destination-uid",
                is_dir: 1,
                size: 0,
                mtime: Date.now(),
                sha1: "",
                remote_revision_uid: "",
                remote_mtime: Date.now(),
            });

            let moveCount = 0;
            mockSdk.moveNodes = async function* (uids: string[], parentUid: string) {
                moveCount++;
                expect(parentUid).toBe("destination-uid");
                yield { uid: uids[0], ok: true };
            };

            const events: {
                absolutePath: string;
                type: "add" | "change" | "unlink";
                isDir: boolean;
            }[] = [];
            for (let index = 0; index < 10; index++) {
                const name = `file-${index}.txt`;
                const oldRelativePath = `source/${name}`;
                const newRelativePath = `destination/${name}`;
                const content = `bulk move ${index}`;
                writeFileSync(path.join(syncRoot, newRelativePath), content);
                db.setMapping({
                    local_path: oldRelativePath,
                    node_uid: `node-${index}`,
                    is_dir: 0,
                    size: Buffer.byteLength(content),
                    mtime: Date.now(),
                    sha1: "",
                    remote_revision_uid: `revision-${index}`,
                    remote_mtime: Date.now(),
                });
                events.push({
                    absolutePath: path.join(syncRoot, oldRelativePath),
                    type: "unlink",
                    isDir: false,
                });
                events.push({
                    absolutePath: path.join(syncRoot, newRelativePath),
                    type: "add",
                    isDir: false,
                });
            }

            (engine as any).isStarted = true;
            (engine as any).remoteRootUid = "root-uid";
            await (engine as any).flushLocalChanges(events);

            expect(moveCount).toBe(10);
            expect(db.getPendingDeletes()).toHaveLength(0);
            for (let index = 0; index < 10; index++) {
                expect(db.getMapping(`source/file-${index}.txt`)).toBeFalsy();
                expect(db.getMapping(`destination/file-${index}.txt`)?.node_uid).toBe(`node-${index}`);
            }
        });

        it("should upload local file if modified locally after remote deletion", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: console.error, debug: mock() }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);

            writeFileSync(path.join(syncRoot, "updated_local.txt"), "modified content");

            db.setMapping({
                local_path: "updated_local.txt",
                node_uid: "del-remote-uid",
                is_dir: 0,
                size: 5,
                mtime: Date.now() - 10000,
                sha1: "oldhash",
                remote_revision_uid: "rev-1",
                remote_mtime: Date.now() - 10000
            });

            mockSdk.iterateFolderChildrenNodeUids = async function* () {};
            mockSdk.iterateNodes = async function* () {};

            (engine as any).isStarted = true;
            await engine.forceSync();

            expect(mockSdk.getFileRevisionUploader).toHaveBeenCalled();
        });

        it("should silently merge unmapped identical files added locally and remotely", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: console.error, debug: mock() }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);

            writeFileSync(path.join(syncRoot, "same.txt"), "identical content");
            const now = Date.now();

            mockSdk.iterateFolderChildrenNodeUids = async function* () { yield "same-uid"; };
            mockSdk.iterateNodes = async function* (uids: string[]) {
                for (const uid of uids) {
                    if (uid === "same-uid") {
                        yield {
                            uid: "same-uid",
                            name: { ok: true, value: "same.txt" },
                            modificationTime: new Date(now),
                            creationTime: new Date(now),
                            size: 17,
                            type: 1,
                            mimeType: "text/plain"
                        };
                    }
                }
            };

            (engine as any).isStarted = true;
            await engine.forceSync();

            expect(db.getMapping("same.txt")).not.toBeNull();
            expect(db.getMapping("same.txt")?.node_uid).toBe("same-uid");
            expect(mockSdk.getFileUploader).not.toHaveBeenCalled();
            expect(mockSdk.getFileDownloader).not.toHaveBeenCalled();
        });

        it("should adopt an unmapped remote node before uploading newer local content", async () => {
            const engine = new SyncEngine(
                db,
                mockSdk,
                mockAuth,
                { info: mock(), warn: mock(), error: mock(), debug: mock() },
                mockEventsManager,
            );
            await engine.setLocalSyncRoot(syncRoot);
            const localPath = path.join(syncRoot, "newer-local.txt");
            writeFileSync(localPath, "newer local content");
            const localTime = new Date();
            utimesSync(localPath, localTime, localTime);
            const remoteTime = Date.now() - 60_000;

            mockSdk.iterateFolderChildrenNodeUids = async function* () {
                yield "existing-node";
            };
            mockSdk.iterateNodes = async function* () {
                yield {
                    uid: "existing-node",
                    name: { ok: true, value: "newer-local.txt" },
                    modificationTime: new Date(remoteTime),
                    creationTime: new Date(remoteTime),
                    type: 1,
                    activeRevision: {
                        ok: true,
                        value: {
                            uid: "existing-revision",
                            claimedSize: 4,
                            claimedModificationTime: new Date(remoteTime),
                            claimedDigests: { sha1: "remote-sha1" },
                        },
                    },
                };
            };
            (engine as any).isStarted = true;

            await engine.forceSync();

            expect(mockSdk.getFileRevisionUploader).toHaveBeenCalledWith(
                "existing-node",
                expect.anything(),
            );
            expect(mockSdk.getFileUploader).not.toHaveBeenCalled();
        });

        it("should complete a safety reconciliation before applying cursor fast-forward events", async () => {
            const engine = new SyncEngine(
                db,
                mockSdk,
                mockAuth,
                { info: mock(), warn: mock(), error: mock(), debug: mock() },
                mockEventsManager,
            );
            (engine as any).isStarted = true;
            let reconciled = false;
            engine.forceSync = async () => {
                reconciled = true;
                db.setConfig("full_sync_in_progress", "0");
            };

            await (engine as any).handleRemoteEvent({
                type: DriveEventType.FastForward,
                treeEventScopeId: "scope",
                eventId: "event",
            });

            expect(reconciled).toBe(true);
        });

        it("should durably reconcile when a new subscription initializes its cursor", async () => {
            const engine = new SyncEngine(
                db,
                mockSdk,
                mockAuth,
                { info: mock(), warn: mock(), error: mock(), debug: mock() },
                mockEventsManager,
            );
            (engine as any).isStarted = true;
            mockSdk.subscribeToTreeEvents = mock().mockResolvedValue({
                getLatestEventId: () => "initial-server-cursor",
                dispose: mock(),
            });
            let reconciled = false;
            engine.forceSync = async () => {
                reconciled = true;
                db.setConfig("full_sync_in_progress", "0");
            };

            await (engine as any).subscribeToRemoteEvents("scope");

            expect(reconciled).toBe(true);
            expect(mockEventsManager.setLatestEventId).toHaveBeenCalledWith(
                "drive",
                "scope",
                "initial-server-cursor",
            );
            expect(db.journal.getPendingRemoteEventCount()).toBe(0);
        });

        it("should not acknowledge an event when durable inboxing fails", async () => {
            mockEventsManager.getLatestEventId = mock().mockResolvedValue(
                "existing-cursor",
            );
            let listener: ((event: any) => Promise<void>) | null = null;
            mockSdk.subscribeToTreeEvents = mock().mockImplementation(
                async (_scope: string, callback: (event: any) => Promise<void>) => {
                    listener = callback;
                    return {
                        getLatestEventId: () => "existing-cursor",
                        dispose: mock(),
                    };
                },
            );
            const engine = new SyncEngine(
                db,
                mockSdk,
                mockAuth,
                { info: mock(), warn: mock(), error: mock(), debug: mock() },
                mockEventsManager,
            );
            (engine as any).isStarted = true;
            const durableFailure = new Error("journal disk failure");
            db.journal.enqueueRemoteEvent = mock(() => {
                throw durableFailure;
            });
            await (engine as any).subscribeToRemoteEvents("scope");

            expect(listener).not.toBeNull();
            await expect(
                listener!({
                    type: DriveEventType.NodeUpdated,
                    treeEventScopeId: "scope",
                    eventId: "next-cursor",
                    nodeUid: "node",
                }),
            ).rejects.toBe(durableFailure);
            expect(mockEventsManager.setLatestEventId).not.toHaveBeenCalledWith(
                "drive",
                "scope",
                "next-cursor",
            );
        });

        it("should create conflict copy when unmapped files with differing content are added locally and remotely", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: console.error, debug: mock() }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);

            writeFileSync(path.join(syncRoot, "diff.txt"), "local diff content");

            mockSdk.iterateFolderChildrenNodeUids = async function* () { yield "diff-uid"; };
            mockSdk.iterateNodes = async function* (uids: string[]) {
                for (const uid of uids) {
                    if (uid === "diff-uid") {
                        yield {
                            uid: "diff-uid",
                            name: { ok: true, value: "diff.txt" },
                            modificationTime: new Date(Date.now() + 50000),
                            creationTime: new Date(Date.now() + 50000),
                            size: 100,
                            type: 1,
                            mimeType: "text/plain",
                            activeRevision: { ok: true, value: { id: "rev-diff", state: 1, claimedModificationTime: Date.now() + 50000, creationTime: new Date() } }
                        };
                    }
                }
            };

            (engine as any).isStarted = true;
            await engine.forceSync();

            expect(mockSdk.getFileDownloader).toHaveBeenCalled();
        });

        it("should drop mapping and ignore path when matching .protonignore rule", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: console.error, debug: mock() }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);

            writeFileSync(path.join(syncRoot, "ignored.tmp"), "temp file");
            writeFileSync(path.join(syncRoot, ".protonignore"), "*.tmp\n");

            db.setMapping({
                local_path: "ignored.tmp",
                node_uid: "ignored-uid",
                is_dir: 0,
                size: 9,
                mtime: Date.now(),
                sha1: "",
                remote_revision_uid: "rev-1",
                remote_mtime: Date.now()
            });

            (engine as any).isStarted = true;
            await engine.forceSync();

            expect(db.getMapping("ignored.tmp")).toBeNull();
        });

        it("should retry operations on temporary network failure via runWithRetry", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: console.error, debug: mock() }, mockEventsManager);

            let attempts = 0;
            const result = await (engine as any).runWithRetry(async () => {
                attempts++;
                if (attempts === 1) {
                    const err: any = new Error("Network error 503");
                    err.status = 503;
                    throw err;
                }
                return "success";
            }, 3, 10);

            expect(attempts).toBe(2);
            expect(result).toBe("success");
        });

        it("should trigger Mass Deletion Guard and auto-pause if > 10 mapped files are missing locally", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: mock(), debug: mock() }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);

            // Map 15 files in DB, but NO local files exist
            const remoteUids: string[] = [];
            for (let i = 1; i <= 15; i++) {
                const uid = `mass-uid-${i}`;
                const relPath = `file-${i}.txt`;
                remoteUids.push(uid);
                db.setMapping({
                    local_path: relPath,
                    node_uid: uid,
                    is_dir: 0,
                    size: 10,
                    mtime: Date.now(),
                    sha1: "abc",
                    remote_revision_uid: `rev-${i}`,
                    remote_mtime: Date.now()
                });
            }

            // Mock remote files matching the DB
            mockSdk.iterateFolderChildrenNodeUids = async function* () {
                for (const uid of remoteUids) yield uid;
            };
            mockSdk.iterateNodes = async function* (uids: string[]) {
                for (const uid of uids) {
                    const idx = uid.replace("mass-uid-", "");
                    yield { 
                        uid, 
                        name: { ok: true, value: `file-${idx}.txt` }, 
                        modificationTime: new Date(), 
                        creationTime: new Date(), 
                        size: 10, 
                        type: 1, 
                        mimeType: "text/plain",
                        activeRevision: { ok: true, value: { uid: `rev-${idx}`, state: 1, claimedModificationTime: Date.now(), creationTime: new Date() } }
                    };
                }
            };

            (engine as any).isStarted = true;
            await engine.forceSync();

            // Sync Engine must have AUTO-PAUSED to protect the remote files from being deleted
            expect((engine as any).isPaused).toBe(true);
        });

        it("should trigger fastSync bulk deletion safeguard and auto-pause if mapped files are missing locally", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: mock(), debug: mock() }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);

            // Map 10 files in DB, but NO local files exist
            for (let i = 1; i <= 10; i++) {
                db.setMapping({
                    local_path: `fast-file-${i}.txt`,
                    node_uid: `fast-uid-${i}`,
                    is_dir: 0,
                    size: 10,
                    mtime: Date.now(),
                    sha1: "abc",
                    remote_revision_uid: `rev-${i}`,
                    remote_mtime: Date.now()
                });
            }

            (engine as any).isStarted = true;
            await engine.fastSync();

            // fastSync must AUTO-PAUSE to protect remote files
            expect((engine as any).isPaused).toBe(true);
            expect((engine as any).bulkDeletionWarning).toBe(true);
        });

        it("should get and set network concurrency limit correctly", () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: mock(), debug: mock() }, mockEventsManager);
            expect(engine.getConcurrencyLimit()).toBe(2);
            expect(engine.getNetworkProfile()).toBe("custom");

            engine.setConcurrencyLimit(4);
            expect(engine.getConcurrencyLimit()).toBe(4);
            expect(db.getConfig("sync_concurrency", "2")).toBe("4");
            expect(engine.getNetworkProfile()).toBe("custom");

            engine.setConcurrencyLimit(6);
            expect(engine.getConcurrencyLimit()).toBe(4);
        });

        it("should apply and persist network profiles", () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: mock(), debug: mock() }, mockEventsManager);

            engine.setNetworkProfile("performance");
            expect(engine.getNetworkProfile()).toBe("performance");
            expect(engine.getConcurrencyLimit()).toBe(5);
            expect(engine.isWifiSafeMode()).toBe(false);

            engine.setNetworkProfile("safe");
            expect(engine.getNetworkProfile()).toBe("safe");
            expect(engine.getConcurrencyLimit()).toBe(1);
            expect(engine.isWifiSafeMode()).toBe(true);

            engine.setWifiSafeMode(false);
            expect(engine.getNetworkProfile()).toBe("performance");
            expect(engine.getConcurrencyLimit()).toBe(5);
            expect(engine.isWifiSafeMode()).toBe(false);
            expect(db.getConfig("sync_network_profile", "")).toBe("performance");
        });

        it("should get and set bandwidth speed limit correctly", () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: mock(), debug: mock() }, mockEventsManager);
            expect(engine.getMaxSpeedKbps()).toBe(0);

            engine.setMaxSpeedKbps(1024);
            expect(engine.getMaxSpeedKbps()).toBe(1024);
            expect(db.getConfig("sync_max_speed_kbps", "0")).toBe("1024");
        });

        it("should get and set Wi-Fi Safe Mode correctly", () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: mock(), debug: mock() }, mockEventsManager);
            expect(engine.isWifiSafeMode()).toBe(false);

            engine.setWifiSafeMode(true);
            expect(engine.isWifiSafeMode()).toBe(true);
            expect(engine.getConcurrencyLimit()).toBe(1);
            expect(db.getConfig("sync_wifi_safe_mode", "0")).toBe("1");
        });

        it("should apply rate limiting to transfers when maxSpeedKbps is set", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { info: mock(), warn: mock(), error: mock(), debug: mock() }, mockEventsManager);
            engine.setMaxSpeedKbps(100); // 100 KB/s limit
            expect(engine.getMaxSpeedKbps()).toBe(100);

            const now = Date.now();
            // Simulate 100ms passed and 20 KB transferred. Target is 100 KB/s, so 20 KB should take 200ms -> expected sleep ~100ms
            (engine as any).transferRateTrackers.set("test.txt", { startTime: now - 100, bytesStart: 0 });
            const startCall = Date.now();
            await (engine as any).rateLimitTransfer("test.txt", 20 * 1024); 
            const elapsed = Date.now() - startCall;
            expect(elapsed).toBeGreaterThanOrEqual(50);
        });
    });
});
