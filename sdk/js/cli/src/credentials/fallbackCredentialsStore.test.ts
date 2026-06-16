import { Logger } from '@protontech/drive-sdk';
import { FallbackCredentialsStore } from './fallbackCredentialsStore';
import type { Credentials, CredentialsStore } from './interface';

class MockCredentialsStore implements CredentialsStore {
    public data: Credentials | null = null;
    public throwOnLoad = false;
    public throwOnSave = false;
    public throwOnRemove = false;
    public loadCalls = 0;
    public saveCalls = 0;
    public removeCalls = 0;

    async load(): Promise<Credentials | null> {
        this.loadCalls++;
        if (this.throwOnLoad) {
            throw new Error('Keyring load failed');
        }
        return this.data;
    }

    async save(snapshot: Credentials): Promise<void> {
        this.saveCalls++;
        if (this.throwOnSave) {
            throw new Error('Keyring save failed');
        }
        this.data = snapshot;
    }

    async remove(): Promise<void> {
        this.removeCalls++;
        if (this.throwOnRemove) {
            throw new Error('Keyring remove failed');
        }
        this.data = null;
    }
}

const mockLogger = {
    debug: () => {},
    warn: () => {},
    error: () => {},
    info: () => {},
} as unknown as Logger;

const testCreds: Credentials = {
    userKeyPassword: 'user-pass',
    session: {
        uid: 'uid-123',
        accessToken: 'token-abc',
    },
};

describe('FallbackCredentialsStore', () => {
    let primary: MockCredentialsStore;
    let fallback: MockCredentialsStore;
    let store: FallbackCredentialsStore;

    beforeEach(() => {
        primary = new MockCredentialsStore();
        fallback = new MockCredentialsStore();
        store = new FallbackCredentialsStore(primary, fallback, mockLogger);
    });

    it('should load from primary under normal operation', async () => {
        primary.data = testCreds;
        const result = await store.load();
        expect(result).toEqual(testCreds);
        expect(primary.loadCalls).toBe(1);
        expect(fallback.loadCalls).toBe(0);
    });

    it('should check fallback store if primary is empty', async () => {
        fallback.data = testCreds;
        const result = await store.load();
        expect(result).toEqual(testCreds);
        expect(primary.loadCalls).toBe(1);
        expect(fallback.loadCalls).toBe(1);
    });

    it('should transparently fall back to fallback store on load failure', async () => {
        primary.throwOnLoad = true;
        fallback.data = testCreds;

        const result = await store.load();
        expect(result).toEqual(testCreds);
        expect(primary.loadCalls).toBe(1);
        expect(fallback.loadCalls).toBe(1);
    });

    it('should save to primary under normal operation', async () => {
        await store.save(testCreds);
        expect(primary.data).toEqual(testCreds);
        expect(fallback.data).toBeNull();
        expect(primary.saveCalls).toBe(1);
        expect(fallback.saveCalls).toBe(0);
    });

    it('should transparently fall back to fallback store on save failure', async () => {
        primary.throwOnSave = true;
        await store.save(testCreds);
        expect(primary.data).toBeNull();
        expect(fallback.data).toEqual(testCreds);
        expect(primary.saveCalls).toBe(1);
        expect(fallback.saveCalls).toBe(1);
    });

    it('should use sticky fallback for saving if load already failed', async () => {
        primary.throwOnLoad = true;
        await store.load(); // triggers fallback mode

        await store.save(testCreds);
        expect(primary.saveCalls).toBe(0); // skipped primary
        expect(fallback.saveCalls).toBe(1);
        expect(fallback.data).toEqual(testCreds);
    });

    it('should remove credentials from both primary and fallback stores', async () => {
        primary.data = testCreds;
        fallback.data = testCreds;

        await store.remove();
        expect(primary.data).toBeNull();
        expect(fallback.data).toBeNull();
        expect(primary.removeCalls).toBe(1);
        expect(fallback.removeCalls).toBe(1);
    });
});
