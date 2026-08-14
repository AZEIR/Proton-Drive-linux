import { createServer, type Server } from 'node:http';

export interface FetchServer {
    stop(force?: boolean): Promise<void> | void;
    port: number;
}

export function serveFetch(options: {
    port: number;
    hostname?: string;
    fetch: (request: Request) => Promise<Response>;
}): FetchServer {
    const server: Server = createServer(async (incoming, outgoing) => {
        const host = incoming.headers.host || `127.0.0.1:${options.port}`;
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) {
                for (const item of value) headers.append(name, item);
            } else if (value !== undefined) {
                headers.set(name, value);
            }
        }

        let body: Buffer | undefined;
        if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
            const chunks: Buffer[] = [];
            let received = 0;
            for await (const chunk of incoming) {
                const buffer = Buffer.from(chunk);
                received += buffer.length;
                if (received > 1024 * 1024) {
                    outgoing.writeHead(413).end('Request body too large');
                    return;
                }
                chunks.push(buffer);
            }
            body = Buffer.concat(chunks);
        }

        const request = new Request(
            `http://${host}${incoming.url || '/'}`,
            {
                method: incoming.method,
                headers,
                body,
                duplex: 'half',
            } as RequestInit,
        );

        try {
            const response = await options.fetch(request);
            outgoing.statusCode = response.status;
            response.headers.forEach((value, name) => outgoing.setHeader(name, value));
            outgoing.setHeader('X-Content-Type-Options', 'nosniff');
            outgoing.setHeader('X-Frame-Options', 'DENY');
            outgoing.setHeader('Referrer-Policy', 'no-referrer');
            outgoing.setHeader(
                'Content-Security-Policy',
                "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'",
            );
            if (!response.body) {
                outgoing.end();
                return;
            }
            const reader = response.body.getReader();
            incoming.once('aborted', () => void reader.cancel());
            outgoing.once('close', () => void reader.cancel());
            while (true) {
                const { done, value } = await reader.read();
                if (done || outgoing.destroyed) break;
                if (!outgoing.write(value)) {
                    await new Promise<void>((resolve) => outgoing.once('drain', resolve));
                }
            }
            if (!outgoing.destroyed) outgoing.end();
        } catch (error: any) {
            if (!outgoing.headersSent) outgoing.statusCode = 500;
            if (!outgoing.destroyed) outgoing.end(error?.message ?? 'Internal Server Error');
        }
    });
    server.requestTimeout = 60_000;
    server.headersTimeout = 15_000;
    server.keepAliveTimeout = 5_000;
    server.listen(options.port, options.hostname ?? '127.0.0.1');

    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : options.port;

    return {
        port: actualPort,
        stop(_force?: boolean) {
            server.closeIdleConnections();
            if (typeof server.closeAllConnections === 'function') {
                server.closeAllConnections();
            }
            return new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
        },
    };
}
