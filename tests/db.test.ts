import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SyncDatabase } from "../src/sync/db";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("SyncDatabase", () => {
    let db: SyncDatabase;
    let dbPath: string;

    beforeEach(() => {
        dbPath = path.join(tmpdir(), `test-sync-${Date.now()}-${Math.random()}.db`);
        db = new SyncDatabase(dbPath);
    });

    afterEach(() => {
        db.close();
        try {
            unlinkSync(dbPath);
            unlinkSync(`${dbPath}-wal`);
            unlinkSync(`${dbPath}-shm`);
        } catch {}
        for (const suffix of [".journal", ".journal-wal", ".journal-shm"]) {
            try { unlinkSync(`${dbPath}${suffix}`); } catch {}
        }
    });

    describe("Config", () => {
        it("should store and retrieve config values", () => {
            db.setConfig("test_key", "test_value");
            expect(db.getConfig("test_key")).toBe("test_value");
        });

        it("should return default value if key not found", () => {
            expect(db.getConfig("missing_key", "default")).toBe("default");
        });

        it("should overwrite existing config values", () => {
            db.setConfig("test_key", "value1");
            db.setConfig("test_key", "value2");
            expect(db.getConfig("test_key")).toBe("value2");
        });
    });

    describe("Mappings", () => {
        const mockMapping = {
            local_path: "folder/file.txt",
            node_uid: "uid-123",
            is_dir: 0,
            size: 1024,
            mtime: 1234567890,
            sha1: "abcdef",
            remote_revision_uid: "rev-123",
            remote_mtime: 1234567890,
        };

        it("should set and get a mapping", () => {
            db.setMapping(mockMapping);
            const retrieved = db.getMapping("folder/file.txt");
            expect(retrieved).toEqual(mockMapping);
        });

        it("should get a mapping by node_uid", () => {
            db.setMapping(mockMapping);
            const retrieved = db.getMappingByNodeUid("uid-123");
            expect(retrieved).toEqual(mockMapping);
        });

        it("should delete a mapping", () => {
            db.setMapping(mockMapping);
            db.deleteMapping("folder/file.txt");
            expect(db.getMapping("folder/file.txt")).toBeFalsy();
        });

        it("should delete a mapping by node_uid", () => {
            db.setMapping(mockMapping);
            db.deleteMappingByNodeUid("uid-123");
            expect(db.getMapping("folder/file.txt")).toBeFalsy();
        });

        it("should handle bulk prefix operations", () => {
            db.setMapping({ ...mockMapping, local_path: "parent/child1.txt", node_uid: "uid-1" });
            db.setMapping({ ...mockMapping, local_path: "parent/child2.txt", node_uid: "uid-2" });
            db.setMapping({ ...mockMapping, local_path: "other/child3.txt", node_uid: "uid-3" });

            // getMappingsByPrefix
            const children = db.getMappingsByPrefix("parent");
            expect(children.length).toBe(2);

            // renameMappingsByPrefix
            const renamed = db.renameMappingsByPrefix("parent", "renamed_parent");
            expect(renamed.length).toBe(2);
            expect(db.getMapping("renamed_parent/child1.txt")).toBeDefined();
            expect(db.getMapping("parent/child1.txt")).toBeFalsy();

            // deleteMappingsByPrefix
            db.deleteMappingsByPrefix("renamed_parent");
            expect(db.getMappingCount()).toBe(1); // Only other/child3.txt remains
        });

        it("should isolate full-sync and FUSE mappings", () => {
            db.setSyncMode("full");
            db.setMapping(mockMapping);
            db.setSyncMode("fuse");
            expect(db.getMapping(mockMapping.local_path)).toBeFalsy();
            db.setMapping({ ...mockMapping, node_uid: "fuse-uid" });
            expect(db.getMapping(mockMapping.local_path)?.node_uid).toBe("fuse-uid");
            db.setSyncMode("full");
            expect(db.getMapping(mockMapping.local_path)?.node_uid).toBe("uid-123");
        });

        it("should return direct children without scanning descendants", () => {
            db.setMapping({ ...mockMapping, local_path: "parent", node_uid: "parent", is_dir: 1 });
            db.setMapping({ ...mockMapping, local_path: "parent/child.txt", node_uid: "child" });
            db.setMapping({ ...mockMapping, local_path: "parent/sub", node_uid: "sub", is_dir: 1 });
            db.setMapping({ ...mockMapping, local_path: "parent/sub/deep.txt", node_uid: "deep" });
            expect(db.getDirectChildren("parent").map((item) => item.local_path)).toEqual([
                "parent/child.txt",
                "parent/sub",
            ]);
        });
    });

    describe("Pending Deletes", () => {
        it("should store and retrieve pending deletes", () => {
            db.setPendingDelete("folder/file.txt", "uid-123", false);
            db.setPendingDelete("folder2", "uid-456", true);

            const pending = db.getPendingDeletes();
            expect(pending.length).toBe(2);
            expect(pending[0].local_path).toBe("folder/file.txt");
            expect(pending[0].is_dir).toBe(0);
            expect(pending[1].local_path).toBe("folder2");
            expect(pending[1].is_dir).toBe(1);
        });

        it("should delete pending deletes", () => {
            db.setPendingDelete("folder/file.txt", "uid-123", false);
            db.deletePendingDelete("folder/file.txt");
            expect(db.getPendingDeletes().length).toBe(0);
        });

        it("should delete pending deletes by prefix", () => {
            db.setPendingDelete("parent/file1.txt", "uid-1", false);
            db.setPendingDelete("parent/file2.txt", "uid-2", false);
            db.deletePendingDeletesByPrefix("parent");
            expect(db.getPendingDeletes().length).toBe(0);
        });
    });

    describe("FUSE pending uploads", () => {
        it("persists failed writeback work until completion", () => {
            db.setPendingFodUpload("document.txt", "node-1", "/tmp/cache-node-1");
            expect(db.getPendingFodUploadCount()).toBe(1);
            db.markPendingFodUploadFailed("document.txt", "offline");
            expect(db.getPendingFodUploads()[0].last_error).toBe("offline");
            db.deletePendingFodUpload("document.txt");
            expect(db.getPendingFodUploadCount()).toBe(0);
        });

        it("finds only uploads whose latest attempt is still failed", () => {
            db.log("retry.txt", "upload", "failed", "offline");
            db.log("recovered.txt", "upload", "failed", "offline");
            db.log("recovered.txt", "upload", "completed", "uploaded");
            expect(db.getUnresolvedFailedUploadPaths()).toEqual(["retry.txt"]);
        });
    });

    describe("Durable operation and event journal", () => {
        it("coalesces queued writeback intents and completes them idempotently", () => {
            const first = db.journal.enqueueOperation({
                syncMode: "fuse",
                stableInodeId: "inode-1",
                kind: "update_file",
                localPath: "document.txt",
                nodeUid: "node-1",
                cachePath: "/tmp/cache-1",
                dedupeKey: "write:document.txt",
            });
            const second = db.journal.enqueueOperation({
                syncMode: "fuse",
                stableInodeId: "inode-1",
                kind: "update_file",
                localPath: "document.txt",
                nodeUid: "node-1",
                cachePath: "/tmp/cache-2",
                dedupeKey: "write:document.txt",
            });

            expect(second).toBe(first);
            expect(db.journal.getReadyOperations()).toHaveLength(1);
            expect(db.journal.getReadyOperations()[0].cache_path).toBe("/tmp/cache-2");
            db.journal.markDedupeKeyCompleted("write:document.txt");
            expect(db.journal.getPendingOperationCount()).toBe(0);
        });

        it("persists a remote event only once until it is applied", () => {
            const event = { eventId: "event-1", type: "NodeUpdated", nodeUid: "node-1" };
            db.journal.enqueueRemoteEvent("scope-1", "event-1", "node-1", "NodeUpdated", event);
            db.journal.enqueueRemoteEvent("scope-1", "event-1", "node-1", "NodeUpdated", event);
            expect(db.journal.getPendingRemoteEventCount()).toBe(1);
            expect(db.journal.getReadyRemoteEvents("scope-1")).toHaveLength(1);
            db.journal.markRemoteEventApplied("scope-1", "event-1");
            expect(db.journal.getPendingRemoteEventCount()).toBe(0);
        });
    });

    describe("Logs", () => {
        it("should insert and retrieve logs", () => {
            db.log("test.txt", "upload", "syncing", "Uploading test file");
            const logs = db.getRecentLogs(10);
            expect(logs.length).toBe(1);
            expect(logs[0].file_path).toBe("test.txt");
            expect(logs[0].direction).toBe("upload");
            expect(logs[0].status).toBe("syncing");
        });

        it("should respect the log limit", () => {
            for (let i = 0; i < 5; i++) {
                db.log(`test${i}.txt`, "upload", "syncing");
            }
            const logs = db.getRecentLogs(3);
            expect(logs.length).toBe(3);
            // Verify we got the most recent ones (highest IDs)
            expect(logs[0].file_path).toBe("test4.txt");
            expect(logs[1].file_path).toBe("test3.txt");
            expect(logs[2].file_path).toBe("test2.txt");
        });
    });
});
