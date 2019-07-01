import { BufferCursor } from '../../BufferCursor';
import Logger from 'js-logger';

const logger = Logger.get('data_formats/parsing/quest/qst');

interface QstContainedFile {
    name: string;
    name2?: string; // Unsure what this is
    questNo?: number;
    expectedSize?: number;
    data: BufferCursor;
    chunkNos: Set<number>;
}

interface ParseQstResult {
    version: string;
    files: QstContainedFile[];
}

/**
 * Low level parsing function for .qst files.
 * Can only read the Blue Burst format.
 */
export function parseQst(cursor: BufferCursor): ParseQstResult | undefined {
    // A .qst file contains two 88-byte headers that describe the embedded .dat and .bin files.
    let version = 'PC';

    // Detect version.
    const versionA = cursor.u8();
    cursor.seek(1);
    const versionB = cursor.u8();

    if (versionA === 0x44) {
        version = 'Dreamcast/GameCube';
    } else if (versionA === 0x58) {
        if (versionB === 0x44) {
            version = 'Blue Burst';
        }
    } else if (versionA === 0xA6) {
        version = 'Dreamcast download';
    }

    if (version === 'Blue Burst') {
        // Read headers and contained files.
        cursor.seek_start(0);

        const headers = parseHeaders(cursor);

        const files = parseFiles(
            cursor, new Map(headers.map(h => [h.fileName, h.size])));

        for (const file of files) {
            const header = headers.find(h => h.fileName === file.name);

            if (header) {
                file.questNo = header.questNo;
                file.name2 = header.fileName2;
            }
        }

        return {
            version,
            files
        };
    } else {
        logger.error(`Can't parse ${version} QST files.`);
        return undefined;
    }
}

interface SimpleQstContainedFile {
    name: string;
    name2?: string;
    questNo?: number;
    data: BufferCursor;
}

interface WriteQstParams {
    version?: string;
    files: SimpleQstContainedFile[];
}

/**
 * Always writes in Blue Burst format.
 */
export function writeQst(params: WriteQstParams): BufferCursor {
    const files = params.files;
    const totalSize = files
        .map(f => 88 + Math.ceil(f.data.size / 1024) * 1056)
        .reduce((a, b) => a + b);
    const cursor = new BufferCursor(totalSize, true);

    writeFileHeaders(cursor, files);
    writeFileChunks(cursor, files);

    if (cursor.size !== totalSize) {
        throw new Error(`Expected a final file size of ${totalSize}, but got ${cursor.size}.`);
    }

    return cursor.seek_start(0);
}

interface QstHeader {
    questNo: number;
    fileName: string;
    fileName2: string;
    size: number;
}

/**
 * TODO: Read all headers instead of just the first 2.
 */
function parseHeaders(cursor: BufferCursor): QstHeader[] {
    const headers = [];

    for (let i = 0; i < 2; ++i) {
        cursor.seek(4);
        const questNo = cursor.u16();
        cursor.seek(38);
        const fileName = cursor.string_ascii(16, true, true);
        const size = cursor.u32();
        // Not sure what this is:
        const fileName2 = cursor.string_ascii(24, true, true);

        headers.push({
            questNo,
            fileName,
            fileName2,
            size
        });
    }

    return headers;
}

function parseFiles(cursor: BufferCursor, expectedSizes: Map<string, number>): QstContainedFile[] {
    // Files are interleaved in 1056 byte chunks.
    // Each chunk has a 24 byte header, 1024 byte data segment and an 8 byte trailer.
    const files = new Map<string, QstContainedFile>();

    while (cursor.bytes_left >= 1056) {
        const startPosition = cursor.position;

        // Read meta data.
        const chunkNo = cursor.seek(4).u8();
        const fileName = cursor.seek(3).string_ascii(16, true, true);

        let file = files.get(fileName);

        if (!file) {
            const expectedSize = expectedSizes.get(fileName);
            files.set(fileName, file = {
                name: fileName,
                expectedSize,
                data: new BufferCursor(expectedSize || (10 * 1024), true),
                chunkNos: new Set()
            });
        }

        if (file.chunkNos.has(chunkNo)) {
            logger.warn(`File chunk number ${chunkNo} of file ${fileName} was already encountered, overwriting previous chunk.`);
        } else {
            file.chunkNos.add(chunkNo);
        }

        // Read file data.
        let size = cursor.seek(1024).u32();
        cursor.seek(-1028);

        if (size > 1024) {
            logger.warn(`Data segment size of ${size} is larger than expected maximum size, reading just 1024 bytes.`);
            size = 1024;
        }

        const data = cursor.take(size);
        const chunkPosition = chunkNo * 1024;
        file.data.size = Math.max(chunkPosition + size, file.data.size);
        file.data.seek_start(chunkPosition).write_cursor(data);

        // Skip the padding and the trailer.
        cursor.seek(1032 - data.size);

        if (cursor.position !== startPosition + 1056) {
            throw new Error(`Read ${cursor.position - startPosition} file chunk message bytes instead of expected 1056.`);
        }
    }

    if (cursor.bytes_left) {
        logger.warn(`${cursor.bytes_left} Bytes left in file.`);
    }

    for (const file of files.values()) {
        // Clean up file properties.
        file.data.seek_start(0);
        file.chunkNos = new Set(Array.from(file.chunkNos.values()).sort((a, b) => a - b));

        // Check whether the expected size was correct.
        if (file.expectedSize != null && file.data.size !== file.expectedSize) {
            logger.warn(`File ${file.name} has an actual size of ${file.data.size} instead of the expected size ${file.expectedSize}.`);
        }

        // Detect missing file chunks.
        const actualSize = Math.max(file.data.size, file.expectedSize || 0);

        for (let chunkNo = 0; chunkNo < Math.ceil(actualSize / 1024); ++chunkNo) {
            if (!file.chunkNos.has(chunkNo)) {
                logger.warn(`File ${file.name} is missing chunk ${chunkNo}.`);
            }
        }
    }

    return Array.from(files.values());
}

function writeFileHeaders(cursor: BufferCursor, files: SimpleQstContainedFile[]): void {
    for (const file of files) {
        if (file.name.length > 16) {
            throw Error(`File ${file.name} has a name longer than 16 characters.`);
        }

        cursor.write_u16(88); // Header size.
        cursor.write_u16(0x44); // Magic number.
        cursor.write_u16(file.questNo || 0);

        for (let i = 0; i < 38; ++i) {
            cursor.write_u8(0);
        }

        cursor.write_string_ascii(file.name, 16);
        cursor.write_u32(file.data.size);

        let fileName2: string;

        if (file.name2 == null) {
            // Not sure this makes sense.
            const dotPos = file.name.lastIndexOf('.');
            fileName2 = dotPos === -1
                ? file.name + '_j'
                : file.name.slice(0, dotPos) + '_j' + file.name.slice(dotPos);
        } else {
            fileName2 = file.name2;
        }

        if (fileName2.length > 24) {
            throw Error(`File ${file.name} has a fileName2 length (${fileName2}) longer than 24 characters.`);
        }

        cursor.write_string_ascii(fileName2, 24);
    }
}

function writeFileChunks(cursor: BufferCursor, files: SimpleQstContainedFile[]): void {
    // Files are interleaved in 1056 byte chunks.
    // Each chunk has a 24 byte header, 1024 byte data segment and an 8 byte trailer.
    files = files.slice();
    const chunkNos = new Array(files.length).fill(0);

    while (files.length) {
        let i = 0;

        while (i < files.length) {
            if (!writeFileChunk(cursor, files[i].data, chunkNos[i]++, files[i].name)) {
                // Remove if there are no more chunks to write.
                files.splice(i, 1);
                chunkNos.splice(i, 1);
            } else {
                ++i;
            }
        }
    }
}

/**
 * @returns true if there are bytes left to write in data, false otherwise.
 */
function writeFileChunk(
    cursor: BufferCursor,
    data: BufferCursor,
    chunkNo: number,
    name: string
): boolean {
    cursor.write_u8_array([28, 4, 19, 0]);
    cursor.write_u8(chunkNo);
    cursor.write_u8_array([0, 0, 0]);
    cursor.write_string_ascii(name, 16);

    const size = Math.min(1024, data.bytes_left);
    cursor.write_cursor(data.take(size));

    // Padding.
    for (let i = size; i < 1024; ++i) {
        cursor.write_u8(0);
    }

    cursor.write_u32(size);
    cursor.write_u32(0);

    return !!data.bytes_left;
}