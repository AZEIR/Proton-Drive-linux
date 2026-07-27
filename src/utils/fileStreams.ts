import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';

const FILE_STREAM_HIGH_WATER_MARK = 1024 * 1024;

/**
 * Return a WHATWG stream for a local file on both Bun and Node.
 *
 * The Proton SDK consumes WHATWG streams. Returning Node's ReadStream here was
 * the reason uploads worked in tests under Bun but failed in the packaged Node
 * daemon (`getReader is not a function`).
 */
export function openFileReadableStream(filePath: string): ReadableStream<Uint8Array> {
    return Readable.toWeb(
        createReadStream(filePath, { highWaterMark: FILE_STREAM_HIGH_WATER_MARK }),
    ) as unknown as ReadableStream<Uint8Array>;
}

/**
 * Create a WHATWG writable stream backed by a local file.
 *
 * Each write resolves only after Node has accepted/flushed that chunk, so the
 * SDK's writer loop naturally observes filesystem backpressure.
 */
export function openFileWritableStream(filePath: string): WritableStream<Uint8Array> {
    const output = createWriteStream(filePath, {
        flags: 'w',
        highWaterMark: FILE_STREAM_HIGH_WATER_MARK,
    });

    return new WritableStream<Uint8Array>({
        write(chunk) {
            return new Promise<void>((resolve, reject) => {
                output.write(Buffer.from(chunk), (error) => {
                    if (error) reject(error);
                    else resolve();
                });
            });
        },
        close() {
            return new Promise<void>((resolve, reject) => {
                output.once('error', reject);
                output.end(() => {
                    output.off('error', reject);
                    resolve();
                });
            });
        },
        abort(reason) {
            output.destroy(reason instanceof Error ? reason : new Error(String(reason ?? 'Transfer aborted')));
        },
    });
}

export async function closeWritableStream(stream: WritableStream<Uint8Array>): Promise<void> {
    const writer = stream.getWriter();
    try {
        await writer.close();
    } finally {
        writer.releaseLock();
    }
}
