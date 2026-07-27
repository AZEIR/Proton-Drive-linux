import { describe, expect, it } from "bun:test";
import { NetworkGovernor } from "../src/utils/networkGovernor";

describe("NetworkGovernor", () => {
    it("bounds concurrent work and preserves queued progress", async () => {
        const governor = new NetworkGovernor({
            mode: "fixed",
            maxFileTransfers: 2,
            maxInFlightBytes: 1024,
        }, false);
        let active = 0;
        let peak = 0;
        const run = () => governor.schedule("full-sync", 128, async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active--;
        });
        await Promise.all([run(), run(), run(), run()]);
        expect(peak).toBe(2);
        expect(governor.getSnapshot().queuedTransfers).toBe(0);
        governor.close();
    });

    it("halves adaptive capacity on rate limiting and honors Retry-After", () => {
        const governor = new NetworkGovernor({
            mode: "adaptive",
            maxFileTransfers: 5,
        }, false);
        governor.evaluateWindow(Date.now() + 5_000);
        governor.evaluateWindow(Date.now() + 10_000);
        expect(governor.getSnapshot().effectiveFileTransfers).toBeGreaterThanOrEqual(2);
        governor.reportFailure({
            status: 429,
            response: { headers: { get: () => "2" } },
        });
        const snapshot = governor.getSnapshot();
        expect(snapshot.state).toBe("rate_limited");
        expect(snapshot.effectiveFileTransfers).toBe(1);
        expect(snapshot.retryAfter).toBeGreaterThan(Date.now());
        governor.close();
    });

    it("applies one aggregate byte rate across callers", async () => {
        const governor = new NetworkGovernor({
            mode: "fixed",
            maxDownloadBps: 100_000,
        }, false);
        const started = Date.now();
        await Promise.all([
            governor.throttle("download", 10_000),
            governor.throttle("download", 10_000),
        ]);
        expect(Date.now() - started).toBeGreaterThanOrEqual(150);
        governor.close();
    });

    it("admits chunks larger than the configured one-second bucket", async () => {
        const governor = new NetworkGovernor({
            mode: "fixed",
            maxDownloadBps: 1_000,
        }, false);
        const started = Date.now();

        await governor.throttle("download", 1_100);

        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(1_000);
        expect(elapsed).toBeLessThan(2_000);
        governor.close();
    });
});
