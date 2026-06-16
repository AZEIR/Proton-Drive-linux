import { DriveEvent, DriveEventType, NodeEntity, NodeType, ProtonDriveClient } from '@protontech/drive-sdk';
import { CacheManager } from './cache';
import { InodeTable } from './inode';
import type { EventsProvider } from '../events/interface';

/**
 * Subscribes to SDK remote tree events and keeps the inode table in sync.
 * When a file is updated remotely:
 *   - its stub size/mtime are corrected
 *   - its cached copy is evicted (is_local → 0) so next open re-downloads
 * When a node is deleted/trashed:
 *   - its inode is removed
 *   - its cached copy is evicted
 */
export class RemoteEventHandler {
    private subscription: any = null;
    private remoteRootUid: string = '';

    constructor(
        private sdk: ProtonDriveClient,
        private inodes: InodeTable,
        private cache: CacheManager,
        private logger: any,
        private onInvalidate?: (ino: number) => void,  // tell FUSE to invalidate cached attrs
        private eventsProvider?: EventsProvider,
    ) {}

    async start(rootFolder: { uid: string; treeEventScopeId: string }) {
        this.remoteRootUid = rootFolder.uid;
        this.logger.info(`[remote-events] Subscribing to scope ${rootFolder.treeEventScopeId}`);

        this.subscription = await this.sdk.subscribeToTreeEvents(
            rootFolder.treeEventScopeId,
            async (event: DriveEvent) => {
                try {
                    await this.handleEvent(event);
                    if (this.eventsProvider) {
                        await this.eventsProvider.setLatestEventId('drive', rootFolder.treeEventScopeId, event.eventId);
                    }
                } catch (err: any) {
                    this.logger.error('[remote-events] Error handling event:', err);
                }
            },
        );

        const latestEventId = this.subscription.getLatestEventId();
        if (latestEventId && this.eventsProvider) {
            this.logger.debug(`[remote-events] Subscribed to scope drive:${rootFolder.treeEventScopeId} with latest event ID ${latestEventId}`);
            await this.eventsProvider.setLatestEventId('drive', rootFolder.treeEventScopeId, latestEventId);
        }
    }

    stop() {
        if (this.subscription) {
            try { this.subscription.dispose(); } catch {}
            this.subscription = null;
        }
    }

    private async handleEvent(event: DriveEvent) {
        // Ignore non-file events
        if (
            event.type === DriveEventType.SharedWithMeUpdated ||
            event.type === DriveEventType.FastForward ||
            event.type === DriveEventType.TreeRefresh
        ) {
            return;
        }

        if (!event || !('nodeUid' in event)) {
            return;
        }
        const nodeUid = (event as any).nodeUid;

        // ── Deletion ──────────────────────────────────────────────────────
        if (event.type === DriveEventType.NodeDeleted) {
            await this.handleDeletion(nodeUid);
            return;
        }

        // ── Fetch node ────────────────────────────────────────────────────
        let node: NodeEntity;
        try {
            node = await this.sdk.getNode(nodeUid);
        } catch {
            return;
        }

        // Trashed counts as deletion
        if (node.trashTime || event.isTrashed) {
            await this.handleDeletion(nodeUid);
            return;
        }

        // Verify it is inside our sync tree
        const hierarchy = await this.sdk.getNodeHierarchy(nodeUid);
        if (hierarchy.length === 0 || hierarchy[0].uid !== this.remoteRootUid) return;

        const relativePath = hierarchy
            .slice(1)
            .map(n => (n.name.ok ? n.name.value : '_degraded_'))
            .join('/');
        if (!relativePath) return;

        // Ensure all parent directories exist in the inode table before processing the node itself
        let currentParentIno = this.inodes.rootIno;
        for (let i = 1; i < hierarchy.length - 1; i++) {
            const parentNode = hierarchy[i];
            const parentName = parentNode.name.ok ? parentNode.name.value : '_degraded_';
            const parentPath = hierarchy
                .slice(1, i + 1)
                .map(n => (n.name.ok ? n.name.value : '_degraded_'))
                .join('/');

            let parentInode = this.inodes.getByUid(parentNode.uid);
            if (!parentInode) {
                this.logger.info(`[remote-events] Recursively creating parent inode for ${parentPath} (uid=${parentNode.uid})`);
                const ino = this.inodes.upsert({
                    node_uid:     parentNode.uid,
                    parent_ino:   currentParentIno,
                    name:         parentName,
                    local_path:   parentPath,
                    is_dir:       1,
                    size:         0,
                    remote_mtime: parentNode.modificationTime.getTime(),
                    is_local:     1,
                    mode:         16877, // 0o40755
                });
                currentParentIno = ino;
            } else {
                currentParentIno = parentInode.ino;
            }
        }

        // ── Created / Updated ─────────────────────────────────────────────
        const inode = this.inodes.getByUid(nodeUid);

        if (node.type === NodeType.Folder) {
            if (!inode) {
                // New remote folder — find parent inode
                const parentPath = relativePath.includes('/')
                    ? relativePath.slice(0, relativePath.lastIndexOf('/'))
                    : '';
                const parentIno = parentPath
                    ? this.inodes.getByPath(parentPath)?.ino ?? this.inodes.rootIno
                    : this.inodes.rootIno;
                const name = relativePath.split('/').pop()!;
                this.inodes.upsert({
                    node_uid:     nodeUid,
                    parent_ino:   parentIno,
                    name,
                    local_path:   relativePath,
                    is_dir:       1,
                    size:         0,
                    remote_mtime: node.modificationTime.getTime(),
                    is_local:     1,
                    mode:         16877, // 0o40755
                });
            } else {
                this.inodes.updateMtime(inode.ino, node.modificationTime.getTime());
                this.onInvalidate?.(inode.ino);
            }
            return;
        }

        // It's a file
        const revision = node.activeRevision?.ok ? node.activeRevision.value : null;
        const size = revision?.claimedSize ?? 0;
        const mtime = revision?.claimedModificationTime
            ? new Date(revision.claimedModificationTime).getTime()
            : node.modificationTime.getTime();

        if (!inode) {
            // New remote file
            const parentPath = relativePath.includes('/')
                ? relativePath.slice(0, relativePath.lastIndexOf('/'))
                : '';
            const parentIno = parentPath
                ? this.inodes.getByPath(parentPath)?.ino ?? this.inodes.rootIno
                : this.inodes.rootIno;
            const name = relativePath.split('/').pop()!;
            this.inodes.upsert({
                node_uid:     nodeUid,
                parent_ino:   parentIno,
                name,
                local_path:   relativePath,
                is_dir:       0,
                size,
                remote_mtime: mtime,
                is_local:     0,   // stub
                mode:         33188, // 0o100644
            });
        } else {
            // Updated file — evict cache so next open re-downloads
            await this.cache.evict(nodeUid);
            this.inodes.setStub(inode.ino);
            this.inodes.updateSize(inode.ino, size);
            this.inodes.updateMtime(inode.ino, mtime);
            this.onInvalidate?.(inode.ino);
            this.logger.info(`[remote-events] Invalidated cache for ${relativePath}`);
        }
    }

    private async handleDeletion(nodeUid: string) {
        const inode = this.inodes.getByUid(nodeUid);
        if (!inode) return;
        this.logger.info(`[remote-events] Remote deletion: ${inode.local_path}`);
        await this.cache.evict(nodeUid);
        this.inodes.delete(inode.ino);
        this.onInvalidate?.(inode.ino);
    }
}
