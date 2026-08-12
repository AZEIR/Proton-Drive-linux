import { isCredentialStoreError } from '../../sdk/cli/src/credentials';

export interface StartupIssue {
    kind: 'credentials' | 'initialization';
    message: string;
}

export function classifyStartupIssue(error: unknown): StartupIssue {
    const detail = error instanceof Error ? error.message : String(error);
    if (isCredentialStoreError(error)) {
        return {
            kind: 'credentials',
            message: `Credential service unavailable: ${detail}`,
        };
    }
    return {
        kind: 'initialization',
        message: `Startup initialization failed: ${detail}`,
    };
}
