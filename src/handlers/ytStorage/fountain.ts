/**
 * Simplified LT (Luby Transform) fountain code implementation.
 *
 * Provides redundancy so that even if some video frames are corrupted
 * (e.g. by YouTube's re-encoding), the original data can be recovered.
 *
 * Encoding: produces M repair packets from N source packets.
 * Decoding: uses repair packets to iteratively recover missing sources.
 */

/**
 * Simple seeded PRNG (xorshift32) for deterministic subset selection.
 */
function xorshift32(seed: number): () => number {
    let state = seed | 1; // avoid zero state
    return () => {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        return (state >>> 0);
    };
}

/**
 * Determine which source packet indices a repair packet covers.
 * Uses a deterministic PRNG seeded by the repair packet index.
 * Selects between 2 and min(5, sourceCount) source packets.
 */
function getRepairSources(repairIndex: number, sourceCount: number): number[] {
    const rng = xorshift32(repairIndex * 2654435761 + 1); // golden ratio hash seed
    const degree = 2 + (rng() % Math.min(4, sourceCount - 1)); // 2..5 sources
    const selected = new Set<number>();
    while (selected.size < degree) {
        selected.add(rng() % sourceCount);
    }
    return Array.from(selected);
}

/**
 * XOR two Uint8Arrays of equal length. Returns a new array.
 */
function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
    const len = Math.max(a.length, b.length);
    const result = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        result[i] = (a[i] || 0) ^ (b[i] || 0);
    }
    return result;
}

export interface RepairPacket {
    /** Index of this repair packet (0-based) */
    repairIndex: number;
    /** Indices of source packets this repair XORs */
    sourceIndices: number[];
    /** XOR'd payload */
    data: Uint8Array;
}

/**
 * Generate fountain repair packets from source data packets.
 * @param sourcePackets Array of source data chunks (all same length, zero-padded if needed)
 * @param redundancyRatio Fraction of extra repair packets (default 0.3 = 30%)
 * @returns Array of repair packets
 */
export function generateRepairPackets(
    sourcePackets: Uint8Array[],
    redundancyRatio: number = 0.3
): RepairPacket[] {
    const n = sourcePackets.length;
    const repairCount = Math.max(1, Math.ceil(n * redundancyRatio));
    const repairs: RepairPacket[] = [];

    for (let r = 0; r < repairCount; r++) {
        const sourceIndices = getRepairSources(r, n);
        let data: Uint8Array = new Uint8Array(sourcePackets[0].length);
        for (const idx of sourceIndices) {
            data = new Uint8Array(xorBytes(data, sourcePackets[idx]));
        }
        repairs.push({ repairIndex: r, sourceIndices, data });
    }

    return repairs;
}

/**
 * Attempt to recover missing source packets using repair packets.
 * Uses iterative peeling: if a repair packet has exactly one unknown source,
 * that source can be recovered by XORing the repair data with the known sources.
 *
 * @param sourcePackets Array where present packets are Uint8Array, missing are null
 * @param repairPackets Array of repair packets
 * @param packetSize Size of each packet in bytes
 * @returns Array of recovered source packets (null entries filled where possible)
 */
export function recoverPackets(
    sourcePackets: (Uint8Array | null)[],
    repairPackets: RepairPacket[],
    packetSize: number
): (Uint8Array | null)[] {
    const recovered = sourcePackets.map(p => p ? new Uint8Array(p) : null);
    let changed = true;

    while (changed) {
        changed = false;
        for (const repair of repairPackets) {
            const missing: number[] = [];
            for (const idx of repair.sourceIndices) {
                if (!recovered[idx]) missing.push(idx);
            }

            if (missing.length === 1) {
                // Can recover the single missing packet
                const missingIdx = missing[0];
                let data: Uint8Array = new Uint8Array(repair.data);
                for (const idx of repair.sourceIndices) {
                    if (idx !== missingIdx && recovered[idx]) {
                        data = new Uint8Array(xorBytes(data, recovered[idx]!));
                    }
                }
                recovered[missingIdx] = new Uint8Array(data);
                changed = true;
            }
        }
    }

    return recovered;
}

/**
 * Re-derive the source indices for a repair packet during decoding.
 * Must match the encoding logic exactly.
 */
export function deriveRepairSources(repairIndex: number, sourceCount: number): number[] {
    return getRepairSources(repairIndex, sourceCount);
}
