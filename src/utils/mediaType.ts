import path from 'node:path';

/**
 * Bun.file().type used to provide upload MIME types on the Bun runtime. The
 * Node runtime has no equivalent, so keep a small deterministic table for the
 * file types users commonly store in Drive. Proton uses this metadata to pick
 * the correct web/mobile placeholder and preview behaviour.
 */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
    // Text and source
    txt: 'text/plain',
    log: 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    mjs: 'text/javascript',
    cjs: 'text/javascript',
    ts: 'text/typescript',
    tsx: 'text/typescript',
    jsx: 'text/jsx',
    json: 'application/json',
    jsonl: 'application/x-ndjson',
    xml: 'application/xml',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    toml: 'application/toml',
    ini: 'text/plain',
    conf: 'text/plain',
    sh: 'text/x-shellscript',
    bash: 'text/x-shellscript',
    zsh: 'text/x-shellscript',
    py: 'text/x-python',
    rs: 'text/x-rust',
    go: 'text/x-go',
    java: 'text/x-java-source',
    c: 'text/x-c',
    h: 'text/x-c',
    cpp: 'text/x-c++',
    hpp: 'text/x-c++',

    // Documents
    pdf: 'application/pdf',
    rtf: 'application/rtf',
    epub: 'application/epub+zip',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    odt: 'application/vnd.oasis.opendocument.text',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odp: 'application/vnd.oasis.opendocument.presentation',

    // Images
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    jpe: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    heic: 'image/heic',
    heif: 'image/heif',
    ico: 'image/x-icon',
    raw: 'image/x-raw',

    // Audio
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    wav: 'audio/wav',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/opus',

    // Video
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    mpg: 'video/mpeg',
    mpeg: 'video/mpeg',
    '3gp': 'video/3gpp',

    // Archives and disk images
    zip: 'application/zip',
    gz: 'application/gzip',
    tgz: 'application/gzip',
    bz2: 'application/x-bzip2',
    xz: 'application/x-xz',
    zst: 'application/zstd',
    tar: 'application/x-tar',
    rar: 'application/vnd.rar',
    '7z': 'application/x-7z-compressed',
    iso: 'application/x-iso9660-image',

    // Fonts and binaries
    ttf: 'font/ttf',
    otf: 'font/otf',
    woff: 'font/woff',
    woff2: 'font/woff2',
    wasm: 'application/wasm',
};

export function getMediaType(filePath: string): string {
    const extension = path.extname(filePath).slice(1).toLowerCase();
    return MEDIA_TYPES[extension] ?? 'application/octet-stream';
}
