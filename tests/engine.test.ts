import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { SyncEngine } from "../src/sync/engine";
import { SyncDatabase } from "../src/sync/db";
import { existsSync, unlinkSync, rmdirSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
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
            stop: mock().mockResolvedValue(undefined)
        };
    });

    afterEach(() => {
        db.close();
        try { unlinkSync(dbPath); } catch {}
        try { unlinkSync(`${dbPath}-wal`); } catch {}
        try { unlinkSync(`${dbPath}-shm`); } catch {}
        try { rmdirSync(syncRoot, { recursive: true }); } catch {}
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

    describe("forceSync", () => {
        it("should perform initial scan and finish", async () => {
            const engine = new SyncEngine(db, mockSdk, mockAuth, { 
                info: mock(), 
                warn: mock(), 
                error: (msg, err) => console.error(msg, err), 
                debug: mock() 
            }, mockEventsManager);
            await engine.setLocalSyncRoot(syncRoot);
            
            // Mock empty remote tree
            mockSdk.iterateFolderChildrenNodeUids = async function* () { };

            await engine.forceSync();
            expect(engine.getStatus()).toBe("idle");
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
            const mapping = db.getMapping("local.txt");
            expect(mapping).toBeDefined();
            expect(mapping?.node_uid).toBe("new-node-uid");
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
            rmdirSync(path.join(syncRoot, "OldDir"), { recursive: true });
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
    });
});

