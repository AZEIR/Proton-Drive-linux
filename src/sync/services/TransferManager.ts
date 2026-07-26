import { EventEmitter } from 'node:events';
import { SyncDatabase } from '../db';
import type { NodeEntity } from '@protontech/drive-sdk';

export interface ActiveTransfer {
    type: 'upload' | 'download';
    size: number;
    transferred: number;
}

export class TransferManager extends EventEmitter {
    private activeTransfers = new Map<string, ActiveTransfer>();
    private downloadQueue: Array<() => Promise<void>> = [];
    private activeDownloadCount = 0;
    private maxConcurrentDownloads = 2; // Conservative limit to preserve Wi-Fi stability

    constructor(
        private db: SyncDatabase,
        private sdk: any,
        private logger: any,
    ) {
        super();
    }

    public getActiveTransfers(): Map<string, ActiveTransfer> {
        return this.activeTransfers;
    }

    public setMaxConcurrentDownloads(limit: number): void {
        this.maxConcurrentDownloads = Math.max(1, limit);
    }

    public trackTransfer(path: string, type: 'upload' | 'download', size: number): void {
        this.activeTransfers.set(path, { type, size, transferred: 0 });
        this.emit('transfersChanged');
    }

    public updateProgress(path: string, transferredBytes: number): void {
        const transfer = this.activeTransfers.get(path);
        if (transfer) {
            transfer.transferred = transferredBytes;
            this.emit('transfersChanged');
        }
    }

    public finishTransfer(path: string): void {
        this.activeTransfers.delete(path);
        this.emit('transfersChanged');
    }

    public abortAll(): void {
        this.activeTransfers.clear();
        this.downloadQueue = [];
        this.activeDownloadCount = 0;
        this.emit('transfersChanged');
    }

    public async enqueueDownload<T>(downloadFn: () => Promise<T>): Promise<T> {
        if (this.activeDownloadCount < this.maxConcurrentDownloads) {
            this.activeDownloadCount++;
            try {
                return await downloadFn();
            } finally {
                this.activeDownloadCount--;
                this.processNextDownload();
            }
        }

        return new Promise<T>((resolve, reject) => {
            this.downloadQueue.push(async () => {
                try {
                    const result = await downloadFn();
                    resolve(result);
                } catch (err) {
                    reject(err);
                }
            });
        });
    }

    private processNextDownload(): void {
        if (this.downloadQueue.length > 0 && this.activeDownloadCount < this.maxConcurrentDownloads) {
            const next = this.downloadQueue.shift();
            if (next) {
                this.activeDownloadCount++;
                next().finally(() => {
                    this.activeDownloadCount--;
                    this.processNextDownload();
                });
            }
        }
    }
}
