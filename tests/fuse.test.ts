import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SyncDatabase } from "../src/sync/db";
import { FodHydrator } from "../src/fod/hydrator";
import { ProtonFuseEngine } from "../src/fod/fuse";

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
            trashNodes: mock().mockResolvedValue([]),
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
});
