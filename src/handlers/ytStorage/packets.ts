/**
 * Packet structure and frame encoding/decoding for YouTube Storage.
 *
 * Each video frame encodes one packet as RGB pixel data.
 * Frame 0 is always the metadata frame containing the original file info.
 *
 * Packet binary layout (header = 19 bytes):
 * ┌────────┬───────┬─────────────┬──────────────┬────────────────┬───────┬─────────┐
 * │ Magic  │ Flags │ Packet Idx  │ Total Pkts   │ Payload Length │ CRC32 │ Payload │
 * │ 2B     │ 1B    │ 4B (u32 LE) │ 4B (u32 LE)  │ 4B (u32 LE)   │ 4B    │ N bytes │
 * └────────┴───────┴─────────────┴──────────────┴────────────────┴───────┴─────────┘
 */

import { crc32 } from "./crc32.ts";

/** Magic bytes identifying a yt-storage frame */
export const MAGIC = 0xDB02;

/** Frame dimensions */
export const FRAME_WIDTH = 1920;
export const FRAME_HEIGHT = 1080;

/** Bytes available per frame for raw packet data (RGB only, no alpha) */
export const FRAME_BYTES = FRAME_WIDTH * FRAME_HEIGHT * 3;

/** Header size in bytes */
export const HEADER_SIZE = 19; // 2 + 1 + 4 + 4 + 4 + 4

/** Maximum payload size per packet */
export const MAX_PAYLOAD = FRAME_BYTES - HEADER_SIZE;

/** Packet flags */
export const FLAG_ENCRYPTED = 0x01;
export const FLAG_REPAIR = 0x02;

export interface PacketHeader {
    magic: number;
    flags: number;
    packetIndex: number;
    totalPackets: number;
    payloadLength: number;
    checksum: number;
}

/**
 * Encode a packet (header + payload) into a flat byte array
 * that will be rendered as RGB pixel data.
 */
export function encodePacket(
    packetIndex: number,
    totalPackets: number,
    payload: Uint8Array,
    flags: number = 0
): Uint8Array {
    const payloadLength = payload.length;
    const checksum = crc32(payload);

    const packet = new Uint8Array(FRAME_BYTES);
    const view = new DataView(packet.buffer);

    // Header
    view.setUint16(0, MAGIC, true);
    view.setUint8(2, flags);
    view.setUint32(3, packetIndex, true);
    view.setUint32(7, totalPackets, true);
    view.setUint32(11, payloadLength, true);
    view.setUint32(15, checksum, true);

    // Payload
    packet.set(payload, HEADER_SIZE);

    return packet;
}

/**
 * Decode a packet from raw bytes (read from frame RGB pixels).
 * Returns null if the magic bytes don't match.
 */
export function decodePacket(raw: Uint8Array): { header: PacketHeader; payload: Uint8Array } | null {
    if (raw.length < HEADER_SIZE) return null;

    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const magic = view.getUint16(0, true);
    if (magic !== MAGIC) return null;

    const flags = view.getUint8(2);
    const packetIndex = view.getUint32(3, true);
    const totalPackets = view.getUint32(7, true);
    const payloadLength = view.getUint32(11, true);
    const checksum = view.getUint32(15, true);

    const payload = raw.slice(HEADER_SIZE, HEADER_SIZE + payloadLength);

    return {
        header: { magic, flags, packetIndex, totalPackets, payloadLength, checksum },
        payload
    };
}

/**
 * Verify a packet's CRC32 checksum.
 */
export function verifyPacket(payload: Uint8Array, expectedChecksum: number): boolean {
    return crc32(payload) === expectedChecksum;
}

// ─── Metadata frame helpers ───

/**
 * Encode file metadata into the payload of frame 0.
 * Layout: [4B filename length] [filename UTF-8] [4B file size] [4B MIME length] [MIME UTF-8]
 */
export function encodeMetadata(
    filename: string,
    fileSize: number,
    mimeType: string,
    isEncrypted: boolean
): Uint8Array {
    const encoder = new TextEncoder();
    const nameBytes = encoder.encode(filename);
    const mimeBytes = encoder.encode(mimeType);

    const total = 4 + nameBytes.length + 4 + 4 + mimeBytes.length + 1;
    const buf = new Uint8Array(total);
    const dv = new DataView(buf.buffer);

    let offset = 0;
    dv.setUint32(offset, nameBytes.length, true); offset += 4;
    buf.set(nameBytes, offset); offset += nameBytes.length;
    dv.setUint32(offset, fileSize, true); offset += 4;
    dv.setUint32(offset, mimeBytes.length, true); offset += 4;
    buf.set(mimeBytes, offset); offset += mimeBytes.length;
    buf[offset] = isEncrypted ? 1 : 0;

    return buf;
}

/**
 * Decode file metadata from frame 0's payload.
 */
export function decodeMetadata(payload: Uint8Array): {
    filename: string;
    fileSize: number;
    mimeType: string;
    isEncrypted: boolean;
} {
    const decoder = new TextDecoder();
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

    let offset = 0;
    const nameLen = dv.getUint32(offset, true); offset += 4;
    const filename = decoder.decode(payload.slice(offset, offset + nameLen)); offset += nameLen;
    const fileSize = dv.getUint32(offset, true); offset += 4;
    const mimeLen = dv.getUint32(offset, true); offset += 4;
    const mimeType = decoder.decode(payload.slice(offset, offset + mimeLen)); offset += mimeLen;
    const isEncrypted = payload[offset] === 1;

    return { filename, fileSize, mimeType, isEncrypted };
}

// ─── Frame pixel conversion ───

/**
 * Convert raw packet bytes to an RGBA pixel buffer (suitable for ImageData).
 * Maps 3 bytes of packet data → 1 pixel (R, G, B, A=255).
 */
export function bytesToPixels(data: Uint8Array): Uint8ClampedArray {
    const pixelCount = FRAME_WIDTH * FRAME_HEIGHT;
    const pixels = new Uint8ClampedArray(pixelCount * 4);

    for (let i = 0; i < pixelCount; i++) {
        const byteOffset = i * 3;
        pixels[i * 4] = data[byteOffset] || 0;       // R
        pixels[i * 4 + 1] = data[byteOffset + 1] || 0; // G
        pixels[i * 4 + 2] = data[byteOffset + 2] || 0; // B
        pixels[i * 4 + 3] = 255;                        // A
    }

    return pixels;
}

/**
 * Convert an RGBA pixel buffer back to raw packet bytes.
 * Extracts R, G, B from each pixel (ignores A).
 */
export function pixelsToBytes(pixels: Uint8ClampedArray): Uint8Array {
    const pixelCount = pixels.length / 4;
    const data = new Uint8Array(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        data[i * 3] = pixels[i * 4];       // R
        data[i * 3 + 1] = pixels[i * 4 + 1]; // G
        data[i * 3 + 2] = pixels[i * 4 + 2]; // B
    }

    return data;
}
