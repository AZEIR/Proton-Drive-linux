import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SyncDatabase } from "../src/sync/db";
import { FodHydrator } from "../src/fod/hydrator";
import { ProtonFuseEngine } from "../src/fod/fuse";
import { FuseDriver } from "../src/fod/fuse-driver";

describe("FUSE File-On-Demand & Dual-Mode System", () => {
    let db: SyncDatabase;
    let mockLogger: any;
    let mockSdk: any;
    let mockAuth: any;
    const testDir = `/tmp/test-fuse-${Date.now()}`;

    beforeEach(() => {
        mkdirSync(testDir, { recursive: true });
        process.env.HOME = testDir;
        
        db = new SyncDatabase(`${testDir}/test-sync.db`);
        mockLogger = { info: mock(), warn: mock(), error: mock(), debug: mock() };
        mockAuth = { isLoggedIn: mock().mockReturnValue(true) };
        mockSdk = {
            getNode: mock().mockResolvedValue({ uid: "node-1", name: "file1.txt" }),
            getFileDownloader: mock().mockResolvedValue({
                downloadToStream: (stream: any) => {
                    const writer = stream.getWriter();
                    writer.write(new TextEncoder().encode("hello fuse content"));
                    return { completion: async () => { try { writer.releaseLock(); } catch {} await stream.close(); } };
                }
            }),
            trashNodes: async function* () {
                yield { uid: "node-1", ok: true };
            },
            createFolder: mock().mockResolvedValue({ uid: "new-folder-uid" }),
            getMyFilesRootFolder: mock().mockResolvedValue({ uid: "root-uid" }),
        };
    });

    afterEach(() => {
        try {
            db.close();
            rmSync(testDir, { recursive: true, force: true });
        } catch {}
    });

    it("should store and retrieve sync mode in database", () => {
        expect(db.getSyncMode()).toBe("full");
        db.setSyncMode("fuse");
        expect(db.getSyncMode()).toBe("fuse");
        db.setSyncMode("full");
        expect(db.getSyncMode()).toBe("full");
    });

    it("should store and retrieve FUSE mount point in database", () => {
        const defaultMount = db.getFuseMountPoint();
        expect(defaultMount).toContain("P-Drive-FUSE");
        db.setFuseMountPoint("/custom/fuse/mount");
        expect(db.getFuseMountPoint()).toBe("/custom/fuse/mount");
    });

    it("FodHydrator should manage file hydration, pinning, and eviction", async () => {
        const hydrator = new FodHydrator(db, mockSdk, mockLogger);
        
        db.setMapping({
            local_path: "document.txt",
            node_uid: "node-doc-1",
            is_dir: 0,
            size: 18,
            mtime: Date.now(),
            sha1: "abc123hash",
            remote_revision_uid: "rev-1",
            remote_mtime: Date.now(),
        });

        expect(hydrator.isHydrated("node-doc-1")).toBe(false);
        expect(hydrator.isPinned("node-doc-1")).toBe(false);

        let startEmitted = false;
        let completeEmitted = false;
        hydrator.on("start", () => { startEmitted = true; });
        hydrator.on("complete", () => { completeEmitted = true; });

        // Hydrate node on-demand
        const cachePath = await hydrator.hydrateNode("node-doc-1", "document.txt");
        expect(existsSync(cachePath)).toBe(true);
        expect(hydrator.isHydrated("node-doc-1")).toBe(true);
        expect(startEmitted).toBe(true);
        expect(completeEmitted).toBe(true);

        const stats = hydrator.getCacheStats();
        expect(stats.totalFiles).toBe(1);
        expect(stats.totalBytes).toBeGreaterThan(0);

        // Pin file
        await hydrator.pinFile("node-doc-1");
        expect(hydrator.isPinned("node-doc-1")).toBe(true);

        // Evict file
        const evicted = await hydrator.evictFile("node-doc-1");
        expect(evicted).toBe(true);
        expect(hydrator.isHydrated("node-doc-1")).toBe(false);
        expect(hydrator.isPinned("node-doc-1")).toBe(false);
    });

    it("FodHydrator should deduplicate simultaneous in-flight hydrations", async () => {
        const hydrator = new FodHydrator(db, mockSdk, mockLogger);
        db.setMapping({
            local_path: "file.txt",
            node_uid: "node-dedup-1",
            is_dir: 0,
            size: 100,
            mtime: Date.now(),
            sha1: "",
            remote_revision_uid: "",
            remote_mtime: Date.now(),
        });

        const p1 = hydrator.hydrateNode("node-dedup-1", "file.txt");
        const p2 = hydrator.hydrateNode("node-dedup-1", "file.txt");

        const [path1, path2] = await Promise.all([p1, p2]);
        expect(path1).toBe(path2);
        expect(existsSync(path1)).toBe(true);
    });

    it("ProtonFuseEngine should implement FodHooks and return active transfers", () => {
        const engine = new ProtonFuseEngine(db, mockSdk, mockAuth, mockLogger, `${testDir}/mount`);
        expect(engine.isFuseMode).toBe(true);
        expect(engine.mountPoint).toBe(`${testDir}/mount`);
        expect(engine.getCached()).toBeArray();
        expect(engine.getCacheStats()).toBeObject();
        expect(engine.getUploads()).toBeArray();
        expect(engine.getActiveTransfers()).toBeArray();
    });

    it("ProtonFuseEngine should persist and publish pause/resume transitions", async () => {
        const engine = new ProtonFuseEngine(db, mockSdk, mockAuth, mockLogger, `${testDir}/mount`);
        const onStatusChanged = mock();
        const scanRemoteTree = mock().mockResolvedValue(undefined);
        engine.on("statusChanged", onStatusChanged);
        engine.scanRemoteTree = scanRemoteTree;

        await engine.pause();
        expect(engine.getStatus()).toBe("paused");
        expect(engine.getIsPaused()).toBe(true);
        expect(db.getConfig("is_sync_paused", "0")).toBe("1");

        await engine.resume();
        expect(engine.getIsPaused()).toBe(false);
        expect(db.getConfig("is_sync_paused", "1")).toBe("0");
        expect(onStatusChanged).toHaveBeenCalledTimes(2);
        expect(scanRemoteTree).toHaveBeenCalledWith(false);
    });

    it("FuseDriver should stream existing files through the revision uploader", async () => {
        db.setSyncMode("fuse");
        const hydrator = new FodHydrator(db, mockSdk, mockLogger);
        const cachePath = hydrator.getCachePath("node-existing");
        writeFileSync(cachePath, "updated content");
        db.setMapping({
            local_path: "document.txt",
            node_uid: "node-existing",
            is_dir: 0,
            size: 15,
            mtime: Date.now(),
            sha1: "",
            remote_revision_uid: "old-revision",
            remote_mtime: Date.now(),
        });
        let uploaded = "";
        const getFileRevisionUploader = mock().mockResolvedValue({
            uploadFromStream: async (stream: ReadableStream<Uint8Array>) => {
                const reader = stream.getReader();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    uploaded += new TextDecoder().decode(value);
                }
                return {
                    completion: async () => ({
                        nodeUid: "node-existing",
                        nodeRevisionUid: "revision-new",
                    }),
                };
            },
        });
        const sdk = {
            ...mockSdk,
            getFileRevisionUploader,
            getFileUploader: mock(),
        };
        const driver = new FuseDriver(`${testDir}/mount`, db, hydrator, sdk, mockLogger);
        await (driver as any).performUpload(
            "document.txt",
            "node-existing",
            cachePath,
            {},
        );
        expect(uploaded).toBe("updated content");
        expect(getFileRevisionUploader).toHaveBeenCalled();
        expect(sdk.getFileUploader).not.toHaveBeenCalled();
        expect(db.getMapping("document.txt")?.remote_revision_uid).toBe("revision-new");
    });

    it("FuseDriver should remove its own stale draft revision and retry once", async () => {
        db.setSyncMode("fuse");
        const hydrator = new FodHydrator(db, mockSdk, mockLogger);
        const cachePath = hydrator.getCachePath("volume-id~node-stale-draft");
        writeFileSync(cachePath, "updated after interrupted upload");
        db.setMapping({
            local_path: "draft.txt",
            node_uid: "volume-id~node-stale-draft",
            is_dir: 0,
            size: 32,
            mtime: Date.now(),
            sha1: "",
            remote_revision_uid: "old-revision",
            remote_mtime: Date.now(),
        });

        const clientUid = "sdk-js-cli-local-client";
        const staleDraftError = Object.assign(
            new Error("Draft revision already exists for this link"),
            {
                code: 2500,
                details: {
                    ConflictDraftRevisionID: "stale-draft-revision",
                    ConflictDraftClientUID: clientUid,
                },
            },
        );
        let completions = 0;
        const sdk = {
            ...mockSdk,
            deleteRevision: mock().mockResolvedValue(undefined),
            getFileRevisionUploader: mock().mockResolvedValue({
                uploadFromStream: async () => ({
                    completion: async () => {
                        completions++;
                        if (completions === 1) throw staleDraftError;
                        return {
                            nodeUid: "volume-id~node-stale-draft",
                            nodeRevisionUid: "replacement-revision",
                        };
                    },
                }),
            }),
        };
        const driver = new FuseDriver(
            `${testDir}/mount`,
            db,
            hydrator,
            sdk,
            mockLogger,
            { clientUid },
        );

        await (driver as any).performUpload("draft.txt", "volume-id~node-stale-draft", cachePath, {});

        expect(sdk.deleteRevision).toHaveBeenCalledWith(
            "volume-id~node-stale-draft~stale-draft-revision",
        );
        expect(sdk.getFileRevisionUploader).toHaveBeenCalledTimes(2);
        expect(db.getMapping("draft.txt")?.remote_revision_uid).toBe("replacement-revision");
    });

    it("FuseDriver should not delete another client's draft revision", async () => {
        db.setSyncMode("fuse");
        const hydrator = new FodHydrator(db, mockSdk, mockLogger);
        const cachePath = hydrator.getCachePath("node-other-draft");
        writeFileSync(cachePath, "local changes");
        db.setMapping({
            local_path: "shared.txt",
            node_uid: "node-other-draft",
            is_dir: 0,
            size: 13,
            mtime: Date.now(),
            sha1: "",
            remote_revision_uid: "old-revision",
            remote_mtime: Date.now(),
        });
        const conflict = Object.assign(new Error("Draft revision already exists"), {
            code: 2500,
            details: {
                ConflictDraftRevisionID: "other-draft",
                ConflictDraftClientUID: "sdk-js-cli-other-client",
            },
        });
        const sdk = {
            ...mockSdk,
            deleteRevision: mock().mockResolvedValue(undefined),
            getFileRevisionUploader: mock().mockResolvedValue({
                uploadFromStream: async () => ({
                    completion: async () => {
                        throw conflict;
                    },
                }),
            }),
        };
        const driver = new FuseDriver(
            `${testDir}/mount`,
            db,
            hydrator,
            sdk,
            mockLogger,
            { clientUid: "sdk-js-cli-local-client" },
        );

        await expect(
            (driver as any).performUpload("shared.txt", "node-other-draft", cachePath, {}),
        ).rejects.toThrow("Draft revision already exists");
        expect(sdk.deleteRevision).not.toHaveBeenCalled();
    });

    it("FuseDriver should upload an immutable snapshot while the live cache changes", async () => {
        db.setSyncMode("fuse");
        const hydrator = new FodHydrator(db, mockSdk, mockLogger);
        const cachePath = hydrator.getCachePath("node-snapshot");
        writeFileSync(cachePath, "first stable version");
        db.setMapping({
            local_path: "rapid.txt",
            node_uid: "node-snapshot",
            is_dir: 0,
            size: 20,
            mtime: Date.now(),
            sha1: "",
            remote_revision_uid: "old-revision",
            remote_mtime: Date.now(),
        });
        let uploaded = "";
        const sdk = {
            ...mockSdk,
            getFileRevisionUploader: mock().mockResolvedValue({
                uploadFromStream: async (stream: ReadableStream<Uint8Array>) => {
                    writeFileSync(cachePath, "second live version");
                    const reader = stream.getReader();
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        uploaded += new TextDecoder().decode(value);
                    }
                    return {
                        completion: async () => ({
                            nodeUid: "node-snapshot",
                            nodeRevisionUid: "snapshot-revision",
                        }),
                    };
                },
            }),
        };
        const driver = new FuseDriver(`${testDir}/mount`, db, hydrator, sdk, mockLogger);

        await (driver as any).performUpload("rapid.txt", "node-snapshot", cachePath, {});

        expect(uploaded).toBe("first stable version");
        await expect(Bun.file(cachePath).text()).resolves.toBe("second live version");
    });

    it("FuseDriver should coalesce writes and retry failed background uploads without rejection leaks", async () => {
        db.setSyncMode("fuse");
        const hydrator = new FodHydrator(db, mockSdk, mockLogger);
        const cachePath = hydrator.getCachePath("node-retry");
        writeFileSync(cachePath, "queued");
        db.setMapping({
            local_path: "queued.txt",
            node_uid: "node-retry",
            is_dir: 0,
            size: 6,
            mtime: Date.now(),
            sha1: "",
            remote_revision_uid: "old-revision",
            remote_mtime: Date.now(),
        });
        const driver = new FuseDriver(
            `${testDir}/mount`,
            db,
            hydrator,
            mockSdk,
            mockLogger,
            {
                uploadDebounceMs: 2,
                uploadRetryBaseMs: 2,
                uploadRetryMaxMs: 5,
            },
        );
        const performUpload = mock()
            .mockRejectedValueOnce(new Error("temporary network failure"))
            .mockResolvedValue(undefined);
        (driver as any).performUpload = performUpload;
        (driver as any).isMounted = true;

        (driver as any).scheduleBackgroundUpload("queued.txt", "node-retry", cachePath);
        (driver as any).scheduleBackgroundUpload("queued.txt", "node-retry", cachePath);
        (driver as any).scheduleBackgroundUpload("queued.txt", "node-retry", cachePath);
        await Bun.sleep(40);

        expect(performUpload).toHaveBeenCalledTimes(2);
        expect(db.getPendingFodUploadCount()).toBe(0);
        expect(mockLogger.warn).toHaveBeenCalled();
    });

    it("FuseDriver should create new files with the public uploader and replace the temporary UID", async () => {
        db.setSyncMode("fuse");
        const hydrator = new FodHydrator(db, mockSdk, mockLogger);
        const tempUid = "local-new-test";
        const cachePath = hydrator.getCachePath(tempUid);
        writeFileSync(cachePath, "new file");
        db.setMapping({
            local_path: "new.txt",
            node_uid: tempUid,
            is_dir: 0,
            size: 8,
            mtime: Date.now(),
            sha1: "",
            remote_revision_uid: "",
            remote_mtime: Date.now(),
        });
        const getFileUploader = mock().mockResolvedValue({
            uploadFromStream: async () => ({
                completion: async () => ({
                    nodeUid: "remote-new",
                    nodeRevisionUid: "revision-new",
                }),
            }),
        });
        const driver = new FuseDriver(
            `${testDir}/mount`,
            db,
            hydrator,
            { ...mockSdk, getFileUploader },
            mockLogger,
        );
        await (driver as any).performUpload("new.txt", tempUid, cachePath, {});
        expect(getFileUploader).toHaveBeenCalledWith(
            "root-uid",
            "new.txt",
            expect.objectContaining({ expectedSize: 8 }),
        );
        expect(db.getMapping("new.txt")?.node_uid).toBe("remote-new");
        expect(existsSync(hydrator.getCachePath("remote-new"))).toBe(true);
        expect(existsSync(cachePath)).toBe(false);
    });

    it("FuseDriver should recover legacy failed uploads from cached writes", () => {
        db.setSyncMode("fuse");
        const hydrator = new FodHydrator(db, mockSdk, mockLogger);
        const cachePath = hydrator.getCachePath("legacy-node");
        writeFileSync(cachePath, "unsynced local edit");
        db.setMapping({
            local_path: "legacy.txt",
            node_uid: "legacy-node",
            is_dir: 0,
            size: 19,
            mtime: Date.now(),
            sha1: "",
            remote_revision_uid: "old-revision",
            remote_mtime: Date.now() - 1000,
        });
        db.log("legacy.txt", "upload", "failed", "uploadFile is not a function");
        const driver = new FuseDriver(`${testDir}/mount`, db, hydrator, mockSdk, mockLogger);
        driver.setPaused(true);
        expect(driver.recoverFailedUploads()).toBe(1);
        expect(db.getPendingFodUploads()).toEqual([
            expect.objectContaining({
                local_path: "legacy.txt",
                node_uid: "legacy-node",
                cache_path: cachePath,
            }),
        ]);
    });

    it("FuseDriver should consume trash generators before removing local state", async () => {
        db.setSyncMode("fuse");
        const hydrator = new FodHydrator(db, mockSdk, mockLogger);
        let generatorConsumed = false;
        const sdk = {
            ...mockSdk,
            trashNodes: async function* () {
                generatorConsumed = true;
                yield { uid: "remote-delete", ok: true };
            },
        };
        const mapping = {
            local_path: "delete.txt",
            node_uid: "remote-delete",
            is_dir: 0,
            size: 0,
            mtime: Date.now(),
            sha1: "",
            remote_revision_uid: "",
            remote_mtime: Date.now(),
        };
        db.setMapping(mapping);
        const driver = new FuseDriver(`${testDir}/mount`, db, hydrator, sdk, mockLogger);
        await (driver as any).deleteRemoteMapping("delete.txt", mapping);
        expect(generatorConsumed).toBe(true);
        expect(db.getMapping("delete.txt")).toBeFalsy();
    });
});
