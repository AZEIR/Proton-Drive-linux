import { createServer } from 'node:net';
import {
    chmodSync,
    lstatSync,
    mkdirSync,
    unlinkSync,
} from 'node:fs';
import path from 'node:path';

export interface ControlHooks {
    status(): unknown;
    dashboardUrl(): string;
    pause(): Promise<void>;
    resume(): Promise<void>;
    sync(): Promise<void>;
    openFolder(): Promise<void>;
}

export interface ControlSocket {
    readonly path: string;
    stop(): Promise<void>;
}

export function startControlSocket(hooks: ControlHooks): ControlSocket {
    const runtimeRoot =
        process.env.XDG_RUNTIME_DIR ||
        path.join('/tmp', `drive-for-linux-${process.getuid?.() ?? process.pid}`);
    const socketDirectory = path.join(runtimeRoot, 'drive-for-linux');
    const socketPath = path.join(socketDirectory, 'control.sock');
    mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
    chmodSync(socketDirectory, 0o700);

    try {
        const existing = lstatSync(socketPath);
        if (
            !existing.isSocket() ||
            (process.getuid && existing.uid !== process.getuid())
        ) {
            throw new Error(`Refusing to replace unsafe control socket path: ${socketPath}`);
        }
        unlinkSync(socketPath);
    } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
    }

    const server = createServer((socket) => {
        socket.setTimeout(5_000, () => socket.destroy());
        let request = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
            request += chunk;
            if (request.length > 64 * 1024) socket.destroy();
            if (!request.includes('\n')) return;
            const line = request.slice(0, request.indexOf('\n'));
            void handleCommand(line, hooks)
                .then((response) => socket.end(`${JSON.stringify(response)}\n`))
                .catch((error: any) => {
                    socket.end(`${JSON.stringify({
                        ok: false,
                        error: error?.message ?? String(error),
                    })}\n`);
                });
        });
    });
    server.listen(socketPath, () => chmodSync(socketPath, 0o600));

    return {
        path: socketPath,
        stop: () => new Promise<void>((resolve) => {
            server.close(() => {
                try {
                    unlinkSync(socketPath);
                } catch {}
                resolve();
            });
        }),
    };
}

async function handleCommand(line: string, hooks: ControlHooks): Promise<unknown> {
    const request = JSON.parse(line) as { command?: string };
    switch (request.command) {
        case 'status':
            return { ok: true, status: hooks.status() };
        case 'dashboard-url':
            return { ok: true, url: hooks.dashboardUrl() };
        case 'pause':
            await hooks.pause();
            return { ok: true };
        case 'resume':
            await hooks.resume();
            return { ok: true };
        case 'sync':
            await hooks.sync();
            return { ok: true };
        case 'open-folder':
            await hooks.openFolder();
            return { ok: true };
        default:
            return { ok: false, error: 'Unsupported control command' };
    }
}
