/**
 * CRC32 (IEEE 802.3 / MPEG-2 variant) checksum implementation.
 * Used for per-packet integrity verification in YouTube Storage encoding.
 */

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
        crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    CRC32_TABLE[i] = crc;
}

/**
 * Compute CRC32 checksum for a byte array.
 * @param data The input bytes
 * @returns 32-bit unsigned CRC32 value
 */
export function crc32(data: Uint8Array): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc = CRC32_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}
