import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { startDashboard } from "../src/sync/dashboard";
import { SyncDatabase } from "../src/sync/db";

describe("Dashboard API", () => {
    let server: any;
    let mockDb: any;
    let mockEngine: any;
    let mockSession: any;
    let mockFod: any;
    const PORT = 8089;
    const BASE_URL = `http://localhost:${PORT}`;

    beforeEach(() => {
        mockDb = {
            log: mock(),
            getRecentLogs: mock().mockReturnValue([{ id: 1, message: "test log" }]),
            getSyncMode: mock().mockReturnValue("full"),
            setSyncMode: mock(),
            getFuseMountPoint: mock().mockReturnValue("/tmp/P-Drive-FUSE"),
        };

        mockEngine = {
            getStatus: mock().mockReturnValue("synced"),
            getActiveTransfers: mock().mockReturnValue([]),
            getLocalSyncRoot: mock().mockReturnValue("/tmp/test-sync"),
            getBulkDeletionCount: mock().mockReturnValue(0),
            getConcurrencyLimit: mock().mockReturnValue(2),
            setConcurrencyLimit: mock(),
            start: mock().mockResolvedValue(undefined),
            stop: mock().mockResolvedValue(undefined),
            pause: mock().mockResolvedValue(undefined),
            resume: mock().mockResolvedValue(undefined),
            forceSync: mock(),
            confirmBulkDeletions: mock().mockResolvedValue(undefined),
            restoreBulkDeletions: mock().mockResolvedValue(undefined),
            setLocalSyncRoot: mock().mockResolvedValue(undefined),
            emit: mock(),
            on: mock(),
            off: mock(),
        };

        mockSession = {
            logger: { info: mock(), error: mock(), warn: mock(), debug: mock() },
            auth: {
                isLoggedIn: mock().mockReturnValue(true),
                authViaWeb: mock().mockResolvedValue(undefined),
                logout: mock().mockResolvedValue(undefined),
            },
            addresses: {
                getOwnPrimaryAddress: mock().mockResolvedValue({ email: "test@example.com" })
            },
            getQuota: mock().mockResolvedValue({
                usedSpace: 50,
                maxSpace: 100
            })
        };

        server = startDashboard(mockDb as any, mockEngine as any, mockSession as any, PORT);
    });

    afterEach(() => {
        if (server) {
            server.stop(true);
        }
    });

    it("GET /api/status should return synced status and email", async () => {
        const res = await fetch(`${BASE_URL}/api/status`);
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.status).toBe("synced");
        expect(data.email).toBe("test@example.com");
        expect(data.localSyncRoot).toBe("/tmp/test-sync");
    });

    it("GET /api/status should handle logged out state", async () => {
        mockSession.auth.isLoggedIn.mockReturnValue(false);
        const res = await fetch(`${BASE_URL}/api/status`);
        const data: any = await res.json();
        expect(data.email).toBe("Not Logged In");
    });

    it("GET /api/quota should return formatted quota", async () => {
        const res = await fetch(`${BASE_URL}/api/quota`);
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.usedSpace).toBe(50);
        expect(data.maxSpace).toBe(100);
        expect(data.percent).toBe(50);
    });

    it("GET /api/logs should return logs from DB", async () => {
        const res = await fetch(`${BASE_URL}/api/logs`);
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.length).toBe(1);
        expect(data[0].message).toBe("test log");
    });

    it("POST /api/pause should call engine.pause", async () => {
        const res = await fetch(`${BASE_URL}/api/pause`, { method: "POST" });
        expect(res.status).toBe(200);
        expect(mockEngine.pause).toHaveBeenCalled();
    });

    it("POST /api/resume should call engine.resume", async () => {
        const res = await fetch(`${BASE_URL}/api/resume`, { method: "POST" });
        expect(res.status).toBe(200);
        expect(mockEngine.resume).toHaveBeenCalled();
    });

    it("POST /api/sync should call engine.forceSync", async () => {
        const res = await fetch(`${BASE_URL}/api/sync`, { method: "POST" });
        expect(res.status).toBe(200);
        expect(mockEngine.forceSync).toHaveBeenCalled();
    });

    it("POST /api/logout should stop engine and session auth", async () => {
        const res = await fetch(`${BASE_URL}/api/logout`, { method: "POST" });
        expect(res.status).toBe(200);
        expect(mockEngine.stop).toHaveBeenCalled();
        expect(mockSession.auth.logout).toHaveBeenCalled();
    });

    it("POST /api/login should return 400 if already logged in", async () => {
        const res = await fetch(`${BASE_URL}/api/login`, { method: "POST" });
        expect(res.status).toBe(400);
        const data: any = await res.json();
        expect(data.error).toBe("Already logged in");
    });

    it("GET /api/status should handle null engine and session gracefully when offline", async () => {
        const offlineServer = startDashboard(mockDb as any, null, null, 8090);
        try {
            const res = await fetch("http://localhost:8090/api/status");
            expect(res.status).toBe(200);
            const data: any = await res.json();
            expect(data.status).toBe("offline");
            expect(data.email).toBe("Not Logged In");
        } finally {
            offlineServer.stop(true);
        }
    });

    it("GET /api/browser/list should return file tree with breadcrumbs and items", async () => {
        mockDb.getAllMappings = mock().mockReturnValue([
            { local_path: "document.txt", node_uid: "n1", is_dir: 0, size: 100, mtime: 1000 },
            { local_path: "folder/file2.txt", node_uid: "n2", is_dir: 0, size: 200, mtime: 2000 },
        ]);
        const res = await fetch(`${BASE_URL}/api/browser/list?path=`);
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.currentPath).toBe("");
        expect(data.breadcrumbs.length).toBe(1);
        expect(data.items.length).toBe(2);
        expect(data.items[0].name).toBe("folder");
        expect(data.items[0].isDir).toBe(true);
        expect(data.items[1].name).toBe("document.txt");
        expect(data.items[1].isDir).toBe(false);
    });

    it("POST /api/set-concurrency should update concurrency limit", async () => {
        const res = await fetch(`${BASE_URL}/api/set-concurrency`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ concurrency: 3 }),
        });
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.ok).toBe(true);
        expect(data.concurrency).toBe(3);
        expect(mockEngine.setConcurrencyLimit).toHaveBeenCalledWith(3);
    });
});

