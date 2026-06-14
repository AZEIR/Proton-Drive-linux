import fs from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { execSync } from 'node:child_process';

if (typeof (globalThis as any).Bun === 'undefined') {
    (globalThis as any).Bun = {
        file(pathStr: string) {
            return {
                _path: pathStr,
                get size() {
                    return fs.existsSync(pathStr) ? fs.statSync(pathStr).size : 0;
                },
                get type() {
                    return 'application/octet-stream';
                },
                get lastModified() {
                    return fs.existsSync(pathStr) ? Math.round(fs.statSync(pathStr).mtimeMs) : 0;
                },
                stream() {
                    const nodeStream = fs.createReadStream(pathStr);
                    return Readable.toWeb(nodeStream);
                },
                exists() {
                    return Promise.resolve(fs.existsSync(pathStr));
                },
                text() {
                    return fs.promises.readFile(pathStr, 'utf8');
                },
                writer() {
                    const nodeStream = fs.createWriteStream(pathStr);
                    return {
                        write(chunk: any) {
                            nodeStream.write(chunk);
                        },
                        flush() {
                            // No-op for compatibility
                        },
                        end() {
                            return new Promise<number>((resolve, reject) => {
                                nodeStream.end((err: any) => {
                                    if (err) reject(err);
                                    else resolve(0);
                                });
                            });
                        }
                    };
                }
            };
        },
        write(destination: string, input: any) {
            return new Promise<number>((resolve, reject) => {
                const proceed = (data: any) => {
                    fs.writeFile(destination, data, (err) => {
                        if (err) reject(err);
                        else resolve(data.length);
                    });
                };

                if (input && typeof input === 'object' && typeof input._path === 'string') {
                    fs.readFile(input._path, (err, data) => {
                        if (err) reject(err);
                        else proceed(data);
                    });
                } else if (input && typeof input === 'object' && typeof input.text === 'function') {
                    input.text().then((textVal: string) => {
                        proceed(textVal);
                    }).catch(reject);
                } else {
                    try {
                        const data = typeof input === 'string' ? input : Buffer.from(input);
                        proceed(data);
                    } catch (err) {
                        reject(err);
                    }
                }
            });
        },
        serve(options: { port: number; fetch: (req: Request) => Promise<Response> | Response }) {
            const http = require('node:http');
            const { Readable } = require('node:stream');

            const server = http.createServer(async (req: any, res: any) => {
                try {
                    const protocol = req.headers['x-forwarded-proto'] || 'http';
                    const host = req.headers.host || `localhost:${options.port}`;
                    const url = new URL(req.url || '', `${protocol}://${host}`);

                    let body: any = null;
                    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '')) {
                        body = Readable.toWeb(req);
                    }

                    const webHeaders = new Headers();
                    for (const [key, value] of Object.entries(req.headers)) {
                        if (Array.isArray(value)) {
                            for (const val of value) webHeaders.append(key, val);
                        } else if (value !== undefined) {
                            webHeaders.append(key, value as string);
                        }
                    }

                    const webReq = new Request(url.toString(), {
                        method: req.method,
                        headers: webHeaders,
                        body: body,
                        // @ts-ignore
                        duplex: 'half'
                    });

                    const webRes = await options.fetch(webReq);

                    res.statusCode = webRes.status;
                    webRes.headers.forEach((value, key) => {
                        res.setHeader(key, value);
                    });

                    if (webRes.body) {
                        const reader = webRes.body.getReader();
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            res.write(value);
                        }
                    }
                    res.end();
                } catch (err) {
                    console.error('[Bun.serve shim] Error:', err);
                    res.statusCode = 500;
                    res.end('Internal Server Error');
                }
            });

            server.listen(options.port);

            return {
                stop() {
                    server.close();
                }
            };
        }
    };
}

if (!(globalThis as any).Bun.secrets) {
    const getBunPath = () => {
        const possiblePaths = [
            path.join(process.cwd(), 'node_modules', '.bin', 'bun'),
            path.join(process.cwd(), 'sdk', 'js', 'cli', 'node_modules', '.bin', 'bun'),
            '/home/azeir/Code/drive-project/node_modules/.bin/bun',
            'bun'
        ];
        for (const p of possiblePaths) {
            try {
                if (fs.existsSync(p)) return p;
            } catch {}
        }
        return 'bun';
    };
    const bunBin = getBunPath();

    (globalThis as any).Bun.secrets = {
        async get(options: { service: string; name: string }) {
            try {
                const code = `Bun.secrets.get(${JSON.stringify(options)}).then(x => console.log(x || ''))`;
                const stdout = execSync(`"${bunBin}" -e ${JSON.stringify(code)}`, { encoding: 'utf8' });
                return stdout.trim() || null;
            } catch (err) {
                return null;
            }
        },
        async set(options: { service: string; name: string; value: string }) {
            try {
                const code = `Bun.secrets.set(${JSON.stringify(options)}).then(() => process.exit(0))`;
                execSync(`"${bunBin}" -e ${JSON.stringify(code)}`);
            } catch (err) {}
        },
        async delete(options: { service: string; name: string }) {
            try {
                const code = `Bun.secrets.delete(${JSON.stringify(options)}).then(() => process.exit(0))`;
                execSync(`"${bunBin}" -e ${JSON.stringify(code)}`);
            } catch (err) {}
        }
    };
}

import '@protontech/drive-sdk/polyfill';

const portStr = process.env.PROTON_SYNC_PORT || '8085';
const port    = parseInt(portStr, 10) || 8085;
const mode    = process.env.PROTON_SYNC_MODE || 'full';

try {
    if (mode === 'full') {
        // Legacy full-sync mode
        const { runSync } = await import('./sync');
        await runSync(port);
    } else {
        // Default: File-On-Demand FUSE daemon
        const { runFuse } = await import('./fuse');
        const mountPoint  = process.env.PROTON_MOUNT_POINT
            ?? (await import('node:os')).homedir() + '/P-Drive';
        await runFuse(mountPoint, port);
    }
} catch (error) {
    console.error('Fatal error starting sync daemon:', error);
    process.exit(1);
}
