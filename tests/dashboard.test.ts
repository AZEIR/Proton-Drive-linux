import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { startAuthenticatedSync, startDashboard } from "../src/sync/dashboard";
import { SyncDatabase } from "../src/sync/db";

describe("Dashboard API", () => {
    let server: any;
    let mockDb: any;
    let mockEngine: any;
    let mockSession: any;
    let mockFod: any;
    let sessionCookie = "";
    let csrfToken = "";
    const PORT = 8089;
    const BASE_URL = `http://localhost:${PORT}`;

    const apiFetch = (path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        headers.set("Origin", BASE_URL);
        headers.set("Cookie", sessionCookie);
        if (!["GET", "HEAD", "OPTIONS"].includes(String(init.method || "GET").toUpperCase())) {
            headers.set("X-CSRF-Token", csrfToken);
        }
        return fetch(`${BASE_URL}${path}`, { ...init, headers });
    };

    const bootstrapDashboard = async (dashboardServer: any) => {
        const bootstrap = await fetch(dashboardServer.getAuthenticatedUrl(), {
            redirect: "manual",
        });
        expect(bootstrap.status).toBe(303);
        return bootstrap.headers.get("set-cookie")!.split(";")[0];
    };

    beforeEach(async () => {
        let concurrencyLimit = 2;
        let maxSpeedKbps = 0;
        let wifiSafeMode = false;
        let networkProfile = "custom";
        mockDb = {
            log: mock(),
            getRecentLogs: mock().mockReturnValue([{ id: 1, message: "test log" }]),
            getSyncMode: mock().mockReturnValue("full"),
            setSyncMode: mock(),
            getFuseMountPoint: mock().mockReturnValue("/tmp/P-Drive-FUSE"),
            journal: {
                getPendingOperationCount: mock().mockReturnValue(2),
                getPendingRemoteEventCount: mock().mockReturnValue(1),
                getPendingOperations: mock().mockReturnValue([{ op_id: "op-1", state: "queued" }]),
            },
        };

        mockEngine = {
            getStatus: mock().mockReturnValue("synced"),
            getActiveTransfers: mock().mockReturnValue([]),
            getLocalSyncRoot: mock().mockReturnValue("/tmp/test-sync"),
            getBulkDeletionCount: mock().mockReturnValue(0),
            getConcurrencyLimit: mock(() => concurrencyLimit),
            setConcurrencyLimit: mock((value: number) => {
                concurrencyLimit = value;
                wifiSafeMode = false;
                networkProfile = "custom";
            }),
            getMaxSpeedKbps: mock(() => maxSpeedKbps),
            setMaxSpeedKbps: mock((value: number) => { maxSpeedKbps = value; }),
            isWifiSafeMode: mock(() => wifiSafeMode),
            setWifiSafeMode: mock((enabled: boolean) => {
                wifiSafeMode = enabled;
                concurrencyLimit = enabled ? 1 : 3;
                networkProfile = enabled ? "safe" : "balanced";
            }),
            getNetworkProfile: mock(() => networkProfile),
            setNetworkProfile: mock((profile: "safe" | "balanced" | "performance") => {
                networkProfile = profile;
                wifiSafeMode = profile === "safe";
                concurrencyLimit = profile === "safe" ? 1 : profile === "balanced" ? 3 : 5;
            }),
            start: mock().mockResolvedValue(undefined),
            startFodEventLoop: mock().mockResolvedValue(undefined),
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
            getNetworkSnapshot: mock().mockReturnValue({
                state: "online",
                queuedTransfers: 0,
                activeTransfers: 0,
            }),
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
        sessionCookie = await bootstrapDashboard(server);
        const sessionResponse = await fetch(`${BASE_URL}/api/v1/session`, {
            headers: { Origin: BASE_URL, Cookie: sessionCookie },
        });
        csrfToken = (await sessionResponse.json() as any).csrfToken;
    });

    afterEach(() => {
        if (server) {
            server.stop(true);
        }
    });

    it("GET /api/status should return synced status and email", async () => {
        const res = await apiFetch("/api/status");
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.status).toBe("synced");
        expect(data.email).toBe("test@example.com");
        expect(data.localSyncRoot).toBe("/tmp/test-sync");
    });

    it("GET / should render the accessible browser UI without the disabled cache tab", async () => {
        const res = await fetch(`${BASE_URL}/`, {
            headers: { Cookie: sessionCookie },
        });
        expect(res.status).toBe(200);
        const csp = res.headers.get("content-security-policy") || "";
        expect(csp).toContain("script-src 'self'");
        expect(csp).toContain("style-src 'self'");
        expect(csp).not.toContain("'unsafe-inline'");
        const html = await res.text();
        expect(html).toContain('aria-label="Dashboard navigation"');
        expect(html).toContain('id="tab-browser"');
        expect(html).not.toContain("Local Cache");
        expect(html).not.toContain("cacheMenuItem");
        expect(html).not.toContain("var(--border)");
        expect(html).not.toContain("var(--bg-hover)");
        expect(html).toContain('src="/assets/dashboard.js?v=ui-polish-2"');
        expect(html).toContain('rel="icon" type="image/svg+xml" href="/assets/favicon.svg?v=ui-polish-2"');
        expect(html).toContain('class="proton-logo" src="/assets/favicon.svg?v=ui-polish-2"');
        expect(html).toContain('<span class="brand-name">Proton Drive');
        expect(html).toContain('id="modeLabel">Sync</span>');
        expect(html).toContain('data-profile="safe"');
        expect(html).not.toContain('id="wifiSafeToggle"');
        expect(html).not.toContain('data-change-action="toggle-wifi-safe"');
        expect(html).not.toContain("fonts.googleapis.com");
        expect(html).toContain("Drive for Linux");
        expect(html).not.toContain("Official Proton Drive Folder Icon");
        expect(html).not.toMatch(/\son(?:click|input|change|submit)=/);
        expect(html).not.toContain(' style="');
        expect(html).toContain('id="concurrencyRange" min="1" max="5"');
        const script = await (await fetch(`${BASE_URL}/assets/dashboard.js`)).text();
        expect(script).toContain("installIconRenderer()");
        expect(script).toContain("ICON_SHAPES");
        expect(script).toContain("isPaused = Boolean(data.isPaused || data.status === 'paused')");
        expect(script).toContain("fetch('/api/set-speed-limit'");
        expect(script).not.toContain("toggleWifiSafeMode");
        const stylesheet = await (await fetch(`${BASE_URL}/assets/dashboard.css`)).text();
        expect(stylesheet).toContain("width: 44px");
        expect(stylesheet).toContain("--accent-visible:");
        const faviconResponse = await fetch(`${BASE_URL}/assets/favicon.svg`);
        expect(faviconResponse.status).toBe(200);
        expect(faviconResponse.headers.get("content-type")).toContain("image/svg+xml");
        expect(await faviconResponse.text()).toContain("<svg");
    });

    it("GET /api/status should handle logged out state", async () => {
        mockSession.auth.isLoggedIn.mockReturnValue(false);
        const res = await apiFetch("/api/status");
        const data: any = await res.json();
        expect(data.email).toBe("Not Logged In");
    });

    it("GET /api/quota should return formatted quota", async () => {
        const res = await apiFetch("/api/quota");
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.usedSpace).toBe(50);
        expect(data.maxSpace).toBe(100);
        expect(data.percent).toBe(50);
    });

    it("GET /api/logs should return logs from DB", async () => {
        const res = await apiFetch("/api/logs");
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.length).toBe(1);
        expect(data[0].message).toBe("test log");
    });

    it("GET /api/v1 exposes authenticated network and journal state", async () => {
        const network = await (await apiFetch("/api/v1/network-policy")).json() as any;
        expect(network.state).toBe("online");
        const journal = await (await apiFetch("/api/v1/journal")).json() as any;
        expect(journal.pendingOperations).toBe(2);
        expect(journal.pendingEvents).toBe(1);
        expect(journal.operations[0].op_id).toBe("op-1");
    });

    it("POST /api/pause should call engine.pause", async () => {
        const res = await apiFetch("/api/pause", { method: "POST" });
        expect(res.status).toBe(200);
        expect(mockEngine.pause).toHaveBeenCalled();
    });

    it("POST /api/resume should call engine.resume", async () => {
        const res = await apiFetch("/api/resume", { method: "POST" });
        expect(res.status).toBe(200);
        expect(mockEngine.resume).toHaveBeenCalled();
    });

    it("should report and route pause/resume state through the FUSE engine", async () => {
        mockFod = {
            isFuseMode: true,
            mountPoint: "/tmp/test-fuse-mount",
            getUploads: mock().mockReturnValue([]),
            getActiveTransfers: mock().mockReturnValue([]),
            getStatus: mock().mockReturnValue("paused"),
            getIsPaused: mock().mockReturnValue(true),
            pause: mock().mockResolvedValue(undefined),
            resume: mock().mockResolvedValue(undefined),
        };
        server.updateContext(mockEngine, mockSession, mockFod);

        const statusRes = await apiFetch("/api/status");
        const status: any = await statusRes.json();
        expect(status.status).toBe("paused");
        expect(status.mode).toBe("fuse");
        expect(status.isPaused).toBe(true);
        expect(status.concurrencyLimit).toBe(2);
        expect(status.maxSpeedKbps).toBe(0);
        expect(status.wifiSafeMode).toBe(false);
        expect(status.networkProfile).toBe("custom");

        const pauseRes = await apiFetch("/api/pause", { method: "POST" });
        const resumeRes = await apiFetch("/api/resume", { method: "POST" });
        expect(pauseRes.status).toBe(200);
        expect(resumeRes.status).toBe(200);
        expect(mockFod.pause).toHaveBeenCalled();
        expect(mockFod.resume).toHaveBeenCalled();
        expect(mockEngine.pause).not.toHaveBeenCalled();
        expect(mockEngine.resume).not.toHaveBeenCalled();
    });

    it("should stream the current paused state in FUSE mode", async () => {
        mockFod = {
            isFuseMode: true,
            mountPoint: "/tmp/test-fuse-mount",
            getUploads: mock().mockReturnValue([]),
            getActiveTransfers: mock().mockReturnValue([]),
            getStatus: mock().mockReturnValue("paused"),
            getIsPaused: mock().mockReturnValue(true),
            on: mock(),
            off: mock(),
        };
        server.updateContext(mockEngine, mockSession, mockFod);

        const response = await apiFetch("/api/events");
        const reader = response.body!.getReader();
        const firstEvent = await reader.read();
        const payload = new TextDecoder().decode(firstEvent.value);
        await reader.cancel();

        expect(response.headers.get("content-type")).toContain("text/event-stream");
        expect(payload).toContain('"status":"paused"');
        expect(payload).toContain('"isPaused":true');
        expect(payload).toContain('"concurrencyLimit":2');
        expect(payload).toContain('"maxSpeedKbps":0');
        expect(payload).toContain('"wifiSafeMode":false');
        expect(payload).toContain('"networkProfile":"custom"');
        expect(payload).toContain('"network":{"state":"online"');
        expect(payload).toContain('"pendingOperations":2');
        expect(payload).toContain('"pendingEvents":1');
    });

    it("should stream live network and journal metrics in full-sync mode", async () => {
        mockEngine.getNetworkSnapshot.mockReturnValue({
            state: "online",
            effectiveFileTransfers: 2,
            activeTransfers: 2,
            queuedTransfers: 1,
            uploadBps: 1024,
            downloadBps: 4096,
        });
        mockEngine.getActiveTransfers.mockReturnValue([
            { filePath: "one.bin", type: "download", size: 10, transferred: 5 },
            { filePath: "two.bin", type: "upload", size: 10, transferred: 2 },
        ]);

        const response = await apiFetch("/api/events");
        const reader = response.body!.getReader();
        const firstEvent = await reader.read();
        const payload = new TextDecoder().decode(firstEvent.value);
        await reader.cancel();

        expect(payload).toContain('"mode":"full"');
        expect(payload).toContain('"effectiveFileTransfers":2');
        expect(payload).toContain('"activeTransfers":2');
        expect(payload).toContain('"queuedTransfers":1');
        expect(payload).toContain('"downloadBps":4096');
        expect(payload).toContain('"pendingOperations":2');
        expect(payload).toContain('"pendingEvents":1');
    });

    it("POST /api/sync should call engine.forceSync", async () => {
        const res = await apiFetch("/api/sync", { method: "POST" });
        expect(res.status).toBe(200);
        expect(mockEngine.forceSync).toHaveBeenCalled();
    });

    it("POST /api/logout should stop engine and session auth", async () => {
        const res = await apiFetch("/api/logout", { method: "POST" });
        expect(res.status).toBe(200);
        expect(mockEngine.stop).toHaveBeenCalled();
        expect(mockSession.auth.logout).toHaveBeenCalled();
    });

    it("POST /api/login should return 400 if already logged in", async () => {
        const res = await apiFetch("/api/login", { method: "POST" });
        expect(res.status).toBe(400);
        const data: any = await res.json();
        expect(data.error).toBe("Already logged in");
    });

    it("should start FUSE instead of full sync after authentication", async () => {
        const fod = {
            isFuseMode: true,
            start: mock().mockResolvedValue(undefined),
        };
        await startAuthenticatedSync(mockEngine, fod as any);
        expect(fod.start).toHaveBeenCalled();
        expect(mockEngine.startFodEventLoop).toHaveBeenCalled();
        expect(mockEngine.start).not.toHaveBeenCalled();
    });

    it("GET /api/status should handle null engine and session gracefully when offline", async () => {
        const offlineServer = startDashboard(mockDb as any, null, null, 8090);
        try {
            const offlineCookie = await bootstrapDashboard(offlineServer);
            const res = await fetch("http://localhost:8090/api/status", {
                headers: { Cookie: offlineCookie },
            });
            expect(res.status).toBe(200);
            const data: any = await res.json();
            expect(data.status).toBe("offline");
            expect(data.email).toBe("Not Logged In");

            offlineServer.updateContext(mockEngine, mockSession);
            const recoveredRes = await fetch("http://localhost:8090/api/status", {
                headers: { Cookie: offlineCookie },
            });
            const recoveredData: any = await recoveredRes.json();
            expect(recoveredData.status).toBe("synced");
            expect(recoveredData.email).toBe("test@example.com");
        } finally {
            offlineServer.stop(true);
        }
    });

    it("GET /api/status should expose a credential startup failure as an error", async () => {
        const credentialServer = startDashboard(
            mockDb as any,
            null,
            null,
            8091,
            undefined,
            {
                kind: "credentials",
                message: "Credential service unavailable: keyring locked",
            },
        );
        try {
            const credentialCookie = await bootstrapDashboard(credentialServer);
            const res = await fetch("http://localhost:8091/api/status", {
                headers: { Cookie: credentialCookie },
            });
            const data: any = await res.json();

            expect(data.status).toBe("error");
            expect(data.startupIssue).toBe("credentials");
            expect(data.error).toBe("Credential service unavailable: keyring locked");

            credentialServer.updateStartupIssue(null);
            const recoveredRes = await fetch("http://localhost:8091/api/status", {
                headers: { Cookie: credentialCookie },
            });
            expect((await recoveredRes.json() as any).status).toBe("offline");
        } finally {
            credentialServer.stop(true);
        }
    });

    it("GET /api/browser/list should return file tree with breadcrumbs and items", async () => {
        mockDb.getAllMappings = mock().mockReturnValue([
            { local_path: "document.txt", node_uid: "n1", is_dir: 0, size: 100, mtime: 1000 },
            { local_path: "folder/file2.txt", node_uid: "n2", is_dir: 0, size: 200, mtime: 2000 },
        ]);
        const res = await apiFetch("/api/browser/list?path=");
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

    it("POST /api/browser/open-item should reject unknown FUSE paths from mappings", async () => {
        mockDb.getAllMappings = mock().mockReturnValue([
            { local_path: "folder/file.txt", node_uid: "n1", is_dir: 0, size: 100, mtime: 1000 },
        ]);
        mockFod = {
            isFuseMode: true,
            mountPoint: "/tmp/test-fuse-mount",
            getCached: mock().mockReturnValue([]),
            getStatus: mock().mockReturnValue("synced"),
            getActiveTransfers: mock().mockReturnValue([]),
            getIsPaused: mock().mockReturnValue(false),
        };
        server.updateContext(mockEngine, mockSession, mockFod);

        const res = await apiFetch("/api/browser/open-item", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ relPath: "not-in-drive" }),
        });
        expect(res.status).toBe(404);
        const data: any = await res.json();
        expect(data.error).toContain("not found in Proton Drive");
    });

    it("POST /api/set-concurrency should update concurrency limit", async () => {
        const res = await apiFetch("/api/set-concurrency", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ concurrency: 3 }),
        });
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.ok).toBe(true);
        expect(data.concurrency).toBe(3);
        expect(mockEngine.setConcurrencyLimit).toHaveBeenCalledWith(3);
        expect(data.networkProfile).toBe("custom");
    });

    it("POST /api/set-concurrency should reject values above the real SDK queue capacity", async () => {
        const res = await apiFetch("/api/set-concurrency", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ concurrency: 6 }),
        });
        expect(res.status).toBe(400);
        expect(mockEngine.setConcurrencyLimit).not.toHaveBeenCalled();
    });

    it("POST /api/set-network-profile should apply the performance profile", async () => {
        const res = await apiFetch("/api/set-network-profile", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ profile: "performance" }),
        });
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.ok).toBe(true);
        expect(data.networkProfile).toBe("performance");
        expect(data.concurrencyLimit).toBe(5);
        expect(data.wifiSafeMode).toBe(false);
        expect(mockEngine.setNetworkProfile).toHaveBeenCalledWith("performance");
    });

    it("POST /api/set-speed-limit should update max speed limit", async () => {
        const res = await apiFetch("/api/set-speed-limit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ maxSpeedKbps: 2048 }),
        });
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.ok).toBe(true);
        expect(data.maxSpeedKbps).toBe(2048);
        expect(mockEngine.setMaxSpeedKbps).toHaveBeenCalledWith(2048);
    });

    it("POST /api/set-wifi-safe-mode should update Wi-Fi Safe Mode", async () => {
        const res = await apiFetch("/api/set-wifi-safe-mode", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: true }),
        });
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.ok).toBe(true);
        expect(data.wifiSafeMode).toBe(true);
        expect(mockEngine.setWifiSafeMode).toHaveBeenCalledWith(true);
    });

    it("should reject cross-origin dashboard API requests", async () => {
        const res = await fetch(`${BASE_URL}/api/pause`, {
            method: "POST",
            headers: { Origin: "https://attacker.example" },
        });
        expect(res.status).toBe(403);
        expect(mockEngine.pause).not.toHaveBeenCalled();
    });

    it("should reject unauthenticated local API reads", async () => {
        const res = await fetch(`${BASE_URL}/api/status`);
        expect(res.status).toBe(403);
    });

    it("should not issue a browser session to an unauthenticated local process", async () => {
        const res = await fetch(`${BASE_URL}/`, { redirect: "manual" });
        expect(res.status).toBe(401);
        expect(res.headers.get("set-cookie")).toBeNull();
    });

    it("should reject non-browser mutations without an Origin header", async () => {
        const res = await fetch(`${BASE_URL}/api/pause`, {
            method: "POST",
            headers: {
                Cookie: sessionCookie,
                "X-CSRF-Token": csrfToken,
            },
        });
        expect(res.status).toBe(403);
        expect(mockEngine.pause).not.toHaveBeenCalled();
    });

    it("should authorize same-origin API requests with cookie and CSRF token", async () => {
        const res = await fetch(`${BASE_URL}/api/pause`, {
            method: "POST",
            headers: {
                Origin: BASE_URL,
                Cookie: sessionCookie,
                "X-CSRF-Token": csrfToken,
            },
        });
        expect(res.status).toBe(200);
        expect(mockEngine.pause).toHaveBeenCalled();
    });

    it("should reject browser paths that escape the configured root", async () => {
        const res = await apiFetch("/api/browser/open-item", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ relPath: "../../etc/passwd" }),
        });
        expect(res.status).toBe(400);
    });
});
