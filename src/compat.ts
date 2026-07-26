import { createServer } from 'node:http';
import { statSync, existsSync, createReadStream, createWriteStream, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setupNetworkSocketLimits } from './utils/httpAgent';

setupNetworkSocketLimits();

if (typeof (globalThis as any).Bun === 'undefined') {
    (globalThis as any).Bun = {};
}

if (typeof (globalThis as any).Bun.file === 'undefined') {
    (globalThis as any).Bun.file = function(filePath: string) {
        return {
            get size() {
                try { return statSync(filePath).size; } catch { return 0; }
            },
            stream() {
                return createReadStream(filePath);
            },
            async exists() {
                return existsSync(filePath);
            },
            async bytes() {
                return new Uint8Array(await readFile(filePath));
            },
            async arrayBuffer() {
                const buf = await readFile(filePath);
                return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            },
            async text() {
                return await readFile(filePath, 'utf-8');
            },
            writer() {
                const stream = createWriteStream(filePath);
                return {
                    write(chunk: any) {
                        stream.write(chunk);
                    },
                    async end() {
                        return new Promise<void>((resolve) => stream.end(resolve));
                    }
                };
            }
        };
    };
    (globalThis as any).Bun.write = async function(filePath: string, data: any) {
        if (typeof data === 'string' || Buffer.isBuffer(data) || data instanceof Uint8Array) {
            await writeFile(filePath, data);
        } else if (data && typeof data.arrayBuffer === 'function') {
            const buf = await data.arrayBuffer();
            await writeFile(filePath, Buffer.from(buf));
        } else if (data && typeof data.text === 'function') {
            const txt = await data.text();
            await writeFile(filePath, txt, 'utf-8');
        } else {
            await writeFile(filePath, String(data));
        }
    };
    (globalThis as any).Bun.serve = function(options: { port: number; hostname?: string; fetch: (req: Request) => Promise<Response> }) {
        const server = createServer(async (nodeReq, nodeRes) => {
            const protocol = 'http';
            const host = nodeReq.headers.host || `127.0.0.1:${options.port}`;
            const fullUrl = `${protocol}://${host}${nodeReq.url || '/'}`;

            const headers = new Headers();
            for (const [key, val] of Object.entries(nodeReq.headers)) {
                if (Array.isArray(val)) {
                    val.forEach(v => headers.append(key, v));
                } else if (val) {
                    headers.set(key, val);
                }
            }

            let body: any = null;
            if (nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD') {
                const chunks: Buffer[] = [];
                for await (const chunk of nodeReq) {
                    chunks.push(Buffer.from(chunk));
                }
                body = Buffer.concat(chunks);
            }

            const request = new Request(fullUrl, {
                method: nodeReq.method,
                headers,
                body,
                duplex: 'half',
            } as any);

            try {
                const response = await options.fetch(request);
                nodeRes.statusCode = response.status;
                response.headers.forEach((v, k) => {
                    nodeRes.setHeader(k, v);
                });

                if (response.body) {
                    const reader = response.body.getReader();
                    const onClose = () => {
                        reader.cancel().catch(() => {});
                    };
                    nodeRes.on('close', onClose);
                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done || nodeRes.writableEnded || nodeRes.destroyed) {
                                reader.cancel().catch(() => {});
                                break;
                            }
                            nodeRes.write(value);
                        }
                    } finally {
                        nodeRes.off('close', onClose);
                    }
                }
                if (!nodeRes.writableEnded && !nodeRes.destroyed) {
                    nodeRes.end();
                }
            } catch (err: any) {
                nodeRes.statusCode = 500;
                nodeRes.end(err?.message || 'Internal Server Error');
            }
        });

        server.listen(options.port, options.hostname || '127.0.0.1');
        return {
            stop() {
                server.close();
            }
        };
    };
}

if (typeof (globalThis as any).Bun.secrets === 'undefined') {
    const getSecretsFile = () => path.join(homedir(), '.config', 'proton-drive-sync', 'secrets.json');
    (globalThis as any).Bun.secrets = {
        async get(opts: { service: string; name: string }) {
            const secretsPath = getSecretsFile();
            if (!existsSync(secretsPath)) return null;
            try {
                const data = JSON.parse(readFileSync(secretsPath, 'utf-8'));
                const key = `${opts.service}:${opts.name}`;
                return data[key] || null;
            } catch {
                return null;
            }
        },
        async set(opts: { service: string; name: string; value: string }) {
            const secretsPath = getSecretsFile();
            let data: Record<string, string> = {};
            if (existsSync(secretsPath)) {
                try { data = JSON.parse(readFileSync(secretsPath, 'utf-8')); } catch {}
            }
            const key = `${opts.service}:${opts.name}`;
            data[key] = opts.value;
            mkdirSync(path.dirname(secretsPath), { recursive: true });
            writeFileSync(secretsPath, JSON.stringify(data, null, 2), { mode: 0o600 });
        },
        async delete(opts: { service: string; name: string }) {
            const secretsPath = getSecretsFile();
            if (!existsSync(secretsPath)) return;
            try {
                const data = JSON.parse(readFileSync(secretsPath, 'utf-8'));
                const key = `${opts.service}:${opts.name}`;
                delete data[key];
                writeFileSync(secretsPath, JSON.stringify(data, null, 2), { mode: 0o600 });
            } catch {}
        }
    };
}
