import { NodeEntity, NodeType, ProtonDriveClient } from '@protontech/drive-sdk';
import { existsSync, statSync, utimesSync } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CacheManager } from './cache';
import { InodeTable } from './inode';

export interface UploadProgress {
    nodeUid: string;
    localPath: string;    // relative
    transferred: number;
    size: number;
    percent: number;
}

/**
 * Wraps the Proton Drive SDK upload flow into a clean promise-based API.
 * Emits 'progress' events with UploadProgress objects.
 * Emits 'done' when complete, 'error' on failure.
 */
export class Uploader extends EventEmitter {
    private _active: Map<string, UploadProgress> = new Map();

    constructor(
        private sdk: ProtonDriveClient,
        private cache: CacheManager,
        private inodes: InodeTable,
        private logger: any,
    ) {
        super();
    }

    /** Upload a newly written temp file from the cache dir to Proton Drive. */
    async uploadFile(
        nodeUid: string | null,    // null = new file
        parentNodeUid: string,
        fileName: string,
        relativePath: string,
        tmpPath: string,
    ): Promise<{ nodeUid: string; revisionUid: string }> {
        if (!existsSync(tmpPath)) {
            throw new Error(`Temp file not found: ${tmpPath}`);
        }

        const file    = Bun.file(tmpPath);
        const size    = file.size;
        const mtime   = file.lastModified && file.lastModified !== 0
            ? new Date(file.lastModified)
            : undefined;
        const metadata = {
            mediaType:        file.type || 'application/octet-stream',
            expectedSize:     size,
            modificationTime: mtime,
        };

        const key = relativePath;
        this._active.set(key, {
            nodeUid:     nodeUid ?? '',
            localPath:   relativePath,
            transferred: 0,
            size,
            percent:     0,
        });
        this.emit('progress', { ...this._active.get(key) });

        const progressCallback = (uploaded: number) => {
            const entry = this._active.get(key);
            if (entry) {
                entry.transferred = Math.min(uploaded, size);
                entry.percent     = size > 0 ? Math.round((entry.transferred / size) * 100) : 0;
                this.emit('progress', { ...entry });
            }
        };

        try {
            // getFileUploader / getFileRevisionUploader both return a FileUploader
            // uploadFromStream returns the controller directly (no await needed)
            const uploader = nodeUid
                ? await this.sdk.getFileRevisionUploader(nodeUid, metadata)
                : await this.sdk.getFileUploader(parentNodeUid, fileName, metadata);

            this.logger.info(
                nodeUid
                    ? `[uploader] Uploading revision for ${relativePath} (uid=${nodeUid})`
                    : `[uploader] Uploading new file ${fileName} to parent ${parentNodeUid}`,
            );

            const controller = await uploader.uploadFromStream(file.stream(), [], progressCallback);
            const result     = await controller.completion();

            // Move temp file to the permanent cache location
            const destPath = this.cache.localPath(result.nodeUid);
            this.cache.ensureDir(result.nodeUid);
            await rename(tmpPath, destPath);

            // Update inode
            const inode = this.inodes.getByPath(relativePath);
            if (inode) {
                this.inodes.setLocal(inode.ino, size, mtime?.getTime() ?? Date.now());
            }

            this.logger.info(`[uploader] Upload complete: ${relativePath} → uid=${result.nodeUid}`);
            this.emit('done', relativePath);
            return { nodeUid: result.nodeUid, revisionUid: result.nodeRevisionUid };
        } catch (err: any) {
            this.logger.error(`[uploader] Upload failed for ${relativePath}:`, err);
            await unlink(tmpPath).catch(() => {});
            this.emit('error', { path: relativePath, error: err });
            throw err;
        } finally {
            this._active.delete(key);
        }
    }


    getActiveUploads(): UploadProgress[] {
        return Array.from(this._active.values());
    }
}

const activeDownloads = new Map<string, Promise<string>>();

/**
 * Downloads a remote node to the local cache.
 * Returns the local cache path.
 */
export async function downloadToCache(
    sdk: ProtonDriveClient,
    cache: CacheManager,
    inodes: InodeTable,
    node: NodeEntity,
    logger: any,
    onProgress?: (bytes: number) => void,
): Promise<string> {
    const existing = activeDownloads.get(node.uid);
    if (existing) {
        return existing;
    }

    const promise = (async () => {
        if (node.type === NodeType.Folder) {
            throw new Error('Cannot download a folder to cache');
        }

        const destPath = cache.localPath(node.uid);
        const tmpPath  = cache.tmpPath(node.uid);

        // Already cached
        if (existsSync(destPath)) {
            return destPath;
        }

        cache.ensureDir(node.uid);

        const revision = node.activeRevision?.ok ? node.activeRevision.value : null;
        const size = revision?.claimedSize ?? 0;

        // Use Bun's file writer (same pattern as CLI download command)
        const bunFile = Bun.file(tmpPath);
        const writer  = bunFile.writer();
        const writableStream: WritableStream = {
            // @ts-expect-error: Bun's FileSink is not fully WritableStream-compatible
            getWriter: () => writer,
            close: async () => { await writer.end(); },
            abort: async () => {
                await writer.end();
                await unlink(tmpPath).catch(() => {});
            },
            locked: false,
        };

        try {
            logger.info(`[downloader] Downloading ${node.uid} (${size} bytes) → ${destPath}`);
            const downloader = await sdk.getFileDownloader(node);
            const controller = downloader.downloadToStream(writableStream, onProgress ?? (() => {}));
            await controller.completion();
            await writer.end();

            // Atomic rename to permanent location
            await mkdir(path.dirname(destPath), { recursive: true }).catch(() => {});
            await rename(tmpPath, destPath);

            // Sync mtime
            const remoteMtime = revision?.claimedModificationTime
                ? new Date(revision.claimedModificationTime).getTime()
                : node.modificationTime.getTime();
            utimesSync(destPath, new Date(), new Date(remoteMtime));

            const localStat = statSync(destPath);
            const inode = inodes.getByUid(node.uid);
            if (inode) {
                inodes.setLocal(inode.ino, localStat.size, remoteMtime);
            }

            logger.info(`[downloader] Done: ${destPath}`);
            return destPath;
        } catch (err: any) {
            try {
                await writer.end();
            } catch {}
            await unlink(tmpPath).catch(() => {});
            logger.error(`[downloader] Failed for ${node.uid}:`, err);
            throw err;
        }
    })();

    activeDownloads.set(node.uid, promise);
    try {
        return await promise;
    } finally {
        activeDownloads.delete(node.uid);
    }
}

