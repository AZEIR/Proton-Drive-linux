import { describe, expect, test } from 'bun:test';

import { CredentialStoreError } from '../sdk/cli/src/credentials';
import { classifyStartupIssue } from '../src/sync/startupIssue';

describe('startup issue classification', () => {
    test('reports credential-store failures without calling the network offline', () => {
        const issue = classifyStartupIssue(new CredentialStoreError(
            'Failed to load session in Secret Service: keyring locked',
            'load',
        ));

        expect(issue).toEqual({
            kind: 'credentials',
            message: 'Credential service unavailable: Failed to load session in Secret Service: keyring locked',
        });
        expect(issue.message.toLowerCase()).not.toContain('offline');
    });

    test('labels unrelated failures as initialization errors', () => {
        expect(classifyStartupIssue(new Error('client UID is invalid'))).toEqual({
            kind: 'initialization',
            message: 'Startup initialization failed: client UID is invalid',
        });
    });

    test('recognizes a bundled credential error by its stable code', () => {
        const error = Object.assign(new Error('secret service unavailable'), {
            code: 'CREDENTIAL_STORE_UNAVAILABLE',
        });
        expect(classifyStartupIssue(error).kind).toBe('credentials');
    });
});
