/**
 * YouTube Storage Handler
 *
 * Encodes any file into a video (ready for YouTube upload) by embedding
 * file data into video frame pixels — with CRC32 checksums, fountain-code
 * redundancy, and optional AES-256-GCM encryption.
 *
 * Decodes the video back into the original file, recovering from
 * corrupted frames using fountain code repair packets.
 *
 * Inspired by https://github.com/PulseBeat02/yt-media-storage
 */

import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import {
    FRAME_WIDTH, FRAME_HEIGHT, MAX_PAYLOAD,
    FLAG_REPAIR, FLAG_ENCRYPTED,
    encodePacket, decodePacket, verifyPacket,
    encodeMetadata, decodeMetadata,
    bytesToPixels, pixelsToBytes,
    type PacketHeader
} from "./ytStorage/packets.ts";
import { generateRepairPackets, recoverPackets, deriveRepairSources } from "./ytStorage/fountain.ts";
import { encrypt, decrypt } from "./ytStorage/crypto.ts";

interface DecodedFrame {
    header: PacketHeader;
    payload: Uint8Array;
    isValid: boolean;
}

class ytStorageHandler implements FormatHandler {

    public name: string = "YouTube Storage";
    public supportAnyInput: boolean = true;
    public supportedFormats: FileFormat[] = [
        {
            name: "YouTube Storage Video",
            format: "yts",
            extension: "webm",
            mime: "video/webm",
            from: true,
            to: true,
            internal: "yts",
            category: "video",
            lossless: true
        }
    ];
    public ready: boolean = false;

    #ffmpeg?: FFmpeg;
    #canvas?: HTMLCanvasElement;
    #ctx?: CanvasRenderingContext2D;

    async #loadFFmpeg() {
        if (!this.#ffmpeg) return;
        await this.#ffmpeg.load({
            coreURL: "/convert/wasm/ffmpeg-core.js"
        });
    }

    async #reloadFFmpeg() {
        if (!this.#ffmpeg) return;
        this.#ffmpeg.terminate();
        await this.#loadFFmpeg();
    }

    async init() {
        this.#ffmpeg = new FFmpeg();
        await this.#loadFFmpeg();
        this.#ffmpeg.terminate();

        this.#canvas = document.createElement("canvas");
        this.#canvas.width = FRAME_WIDTH;
        this.#canvas.height = FRAME_HEIGHT;
        const ctx = this.#canvas.getContext("2d");
        if (!ctx) throw "Failed to create 2D rendering context.";
        this.#ctx = ctx;

        this.ready = true;
    }

    async doConvert(
        inputFiles: FileData[],
        inputFormat: FileFormat,
        outputFormat: FileFormat,
        args?: string[]
    ): Promise<FileData[]> {
        if (!this.ready || !this.#ffmpeg || !this.#canvas || !this.#ctx) {
            throw "Handler not initialized.";
        }

        const isEncoding = outputFormat.internal === "yts";

        if (isEncoding) {
            return this.#encode(inputFiles, inputFormat, args);
        } else {
            return this.#decode(inputFiles, args);
        }
    }

    // ─── ENCODE: any file → YouTube Storage Video ───

    async #encode(
        inputFiles: FileData[],
        inputFormat: FileFormat,
        args?: string[]
    ): Promise<FileData[]> {
        const outputFiles: FileData[] = [];

        // Parse optional encryption flag
        const encryptFlag = args?.includes("--encrypt");
        const passwordIdx = args?.indexOf("--password");
        const password = (encryptFlag && passwordIdx !== undefined && passwordIdx >= 0)
            ? args![passwordIdx + 1]
            : undefined;

        for (const inputFile of inputFiles) {
            let fileBytes = new Uint8Array(inputFile.bytes);
            const originalName = inputFile.name;
            const originalSize = fileBytes.length;
            const originalMime = inputFormat.mime;

            // Optionally encrypt
            const isEncrypted = !!(encryptFlag && password);
            if (isEncrypted) {
                fileBytes = new Uint8Array(await encrypt(fileBytes, password!));
            }

            // Split file into fixed-size chunks
            const chunkSize = MAX_PAYLOAD;
            const sourceChunks: Uint8Array[] = [];
            for (let offset = 0; offset < fileBytes.length; offset += chunkSize) {
                const end = Math.min(offset + chunkSize, fileBytes.length);
                const chunk = new Uint8Array(chunkSize); // zero-padded
                chunk.set(fileBytes.slice(offset, end));
                sourceChunks.push(chunk);
            }

            // Generate repair packets (fountain codes)
            const repairPackets = generateRepairPackets(sourceChunks, 0.3);

            // Total frames: 1 metadata + N source + M repair
            const totalSourcePackets = sourceChunks.length;
            const totalRepairPackets = repairPackets.length;
            const totalFrames = 1 + totalSourcePackets + totalRepairPackets;

            // Create metadata packet (frame 0)
            const metaPayload = encodeMetadata(originalName, originalSize, originalMime, isEncrypted);
            const metaFlags = isEncrypted ? FLAG_ENCRYPTED : 0;
            const metaPacketBytes = encodePacket(0, totalFrames, metaPayload, metaFlags);

            // Prepare all frames as PNG images
            await this.#reloadFFmpeg();

            // Write frame 0 (metadata)
            await this.#writeFramePNG(0, metaPacketBytes);

            // Write source data frames (1..N)
            for (let i = 0; i < totalSourcePackets; i++) {
                const actualLength = Math.min(
                    chunkSize,
                    fileBytes.length - i * chunkSize
                );
                const payload = sourceChunks[i].slice(0, actualLength);
                const packetBytes = encodePacket(i + 1, totalFrames, payload, 0);
                await this.#writeFramePNG(i + 1, packetBytes);
            }

            // Write repair frames (N+1..N+M)
            for (let r = 0; r < totalRepairPackets; r++) {
                const repair = repairPackets[r];
                const packetBytes = encodePacket(
                    totalSourcePackets + r + 1,
                    totalFrames,
                    repair.data,
                    FLAG_REPAIR
                );
                await this.#writeFramePNG(totalSourcePackets + r + 1, packetBytes);
            }

            // Run FFmpeg to encode frames into video
            // Use libx264 with CRF 0 (lossless) and rgb24 pixel format
            await this.#ffmpeg!.exec([
                "-hide_banner",
                "-framerate", "30",
                "-i", "frame_%d.png",
                "-c:v", "libvpx-vp9",
                "-lossless", "1",
                "-row-mt", "1",
                "output.webm"
            ]);

            // Read output video
            const videoData = await this.#ffmpeg!.readFile("output.webm");
            if (!(videoData instanceof Uint8Array) || videoData.length === 0) {
                throw "FFmpeg failed to produce output video.";
            }
            const videoBytes = new Uint8Array(videoData.buffer);

            // Cleanup virtual filesystem
            for (let i = 0; i < totalFrames; i++) {
                try { await this.#ffmpeg!.deleteFile(`frame_${i}.png`); } catch (_) { }
            }
            try { await this.#ffmpeg!.deleteFile("output.webm"); } catch (_) { }

            const baseName = originalName.split(".")[0];
            outputFiles.push({
                bytes: videoBytes,
                name: `${baseName}.yts.webm`
            });
        }

        return outputFiles;
    }

    // ─── DECODE: YouTube Storage Video → original file ───

    async #decode(
        inputFiles: FileData[],
        args?: string[]
    ): Promise<FileData[]> {
        const outputFiles: FileData[] = [];

        const passwordIdx = args?.indexOf("--password");
        const password = (passwordIdx !== undefined && passwordIdx >= 0)
            ? args![passwordIdx + 1]
            : undefined;

        for (const inputFile of inputFiles) {
            await this.#reloadFFmpeg();

            // Write input video to FFmpeg VFS
            await this.#ffmpeg!.writeFile("input.webm", new Uint8Array(inputFile.bytes));

            // Extract frames as PNG
            await this.#ffmpeg!.exec([
                "-hide_banner",
                "-i", "input.webm",
                "-pix_fmt", "rgb24",
                "frame_%d.png"
            ]);

            // Read all frames and decode packets
            let frameIndex = 0;
            const decodedPackets: Map<number, DecodedFrame> = new Map();

            while (true) {
                let frameData: Uint8Array;
                try {
                    // FFmpeg outputs 1-indexed frames
                    const rawFrame = await this.#ffmpeg!.readFile(`frame_${frameIndex + 1}.png`);
                    if (!(rawFrame instanceof Uint8Array) || rawFrame.length === 0) break;
                    frameData = rawFrame;
                } catch (_) {
                    break;
                }

                // Decode PNG to pixel data using canvas
                const pixelData = await this.#pngToPixels(frameData);
                if (!pixelData) {
                    frameIndex++;
                    continue;
                }

                // Extract raw bytes from pixels
                const rawBytes = pixelsToBytes(pixelData);
                const decoded = decodePacket(rawBytes);

                if (decoded) {
                    const isValid = verifyPacket(decoded.payload, decoded.header.checksum);
                    decodedPackets.set(frameIndex, { ...decoded, isValid });
                }

                frameIndex++;
            }

            if (decodedPackets.size === 0) {
                throw "No valid YouTube Storage frames found in video.";
            }

            // Find metadata packet (frame 0)
            const metaEntry = decodedPackets.get(0);
            if (!metaEntry || !metaEntry.isValid) {
                throw "Metadata frame is missing or corrupted.";
            }
            const metadata = decodeMetadata(metaEntry.payload);
            const totalFrames = metaEntry.header.totalPackets;

            // Separate source and repair packets
            // Frame 0 = metadata, frames 1..N = source, frames N+1.. = repair
            const sourcePackets: (Uint8Array | null)[] = [];
            const repairPacketsDecoded: { repairIndex: number; data: Uint8Array; sourceIndices: number[] }[] = [];

            // Count how many source vs repair frames we expect
            // We need to figure out how many are source vs repair
            // From the encoder: totalFrames = 1 + totalSource + totalRepair
            // We'll identify repairs by their FLAG_REPAIR flag
            let sourceCount = 0;
            let repairCount = 0;

            for (let i = 1; i < totalFrames; i++) {
                const entry = decodedPackets.get(i);
                if (entry && (entry.header.flags & FLAG_REPAIR)) {
                    repairCount++;
                } else {
                    sourceCount++;
                }
            }

            // Initialize source packets array
            for (let i = 0; i < sourceCount; i++) {
                sourcePackets.push(null);
            }

            // Populate source and repair packets
            let sourceIdx = 0;
            let repairIdx = 0;
            for (let i = 1; i < totalFrames; i++) {
                const entry = decodedPackets.get(i);
                if (!entry) {
                    if (sourceIdx < sourceCount) {
                        // Missing source packet
                        sourceIdx++;
                    } else {
                        repairIdx++;
                    }
                    continue;
                }

                if (entry.header.flags & FLAG_REPAIR) {
                    // Repair packet
                    const repairIndex = repairIdx;
                    const sourceIndices = deriveRepairSources(repairIndex, sourceCount);
                    if (entry.isValid) {
                        repairPacketsDecoded.push({
                            repairIndex,
                            data: entry.payload,
                            sourceIndices
                        });
                    }
                    repairIdx++;
                } else {
                    // Source packet
                    if (entry.isValid) {
                        sourcePackets[sourceIdx] = entry.payload;
                    }
                    sourceIdx++;
                }
            }

            // Attempt fountain code recovery for missing packets
            const packetSize = sourcePackets.find(p => p !== null)?.length || MAX_PAYLOAD;
            const recovered = recoverPackets(sourcePackets, repairPacketsDecoded, packetSize);

            // Check all source packets are recovered
            for (let i = 0; i < sourceCount; i++) {
                if (!recovered[i]) {
                    throw `Failed to recover source packet ${i}. Too many corrupted frames.`;
                }
            }

            // Concatenate source packets and trim to original file size
            let totalBytes = 0;
            for (const pkt of recovered) {
                totalBytes += pkt!.length;
            }

            let fileBytes: Uint8Array;
            if (metadata.isEncrypted) {
                // For encrypted files, the "file size" in metadata is the original unencrypted size,
                // but the encrypted data is larger. We need to reconstruct the encrypted blob first.
                const encryptedSize = totalBytes; // use all bytes from packets
                const encryptedBuf = new Uint8Array(encryptedSize);
                let offset = 0;
                for (const pkt of recovered) {
                    encryptedBuf.set(pkt!, offset);
                    offset += pkt!.length;
                }
                // Trim trailing padding — encrypted payload may be slightly shorter than total capacity
                // The encrypted size = original size + salt(16) + iv(12) + tag(16) = original + 44
                const expectedEncSize = metadata.fileSize + 44;
                const encryptedData = encryptedBuf.slice(0, expectedEncSize);

                if (!password) {
                    throw "File is encrypted. Provide --password argument.";
                }
                fileBytes = await decrypt(encryptedData, password);
            } else {
                fileBytes = new Uint8Array(metadata.fileSize);
                let offset = 0;
                for (const pkt of recovered) {
                    const copyLen = Math.min(pkt!.length, metadata.fileSize - offset);
                    fileBytes.set(pkt!.slice(0, copyLen), offset);
                    offset += copyLen;
                    if (offset >= metadata.fileSize) break;
                }
            }

            // Cleanup VFS
            try { await this.#ffmpeg!.deleteFile("input.mp4"); } catch (_) { }
            for (let i = 0; i <= frameIndex; i++) {
                try { await this.#ffmpeg!.deleteFile(`frame_${i + 1}.png`); } catch (_) { }
            }

            outputFiles.push({
                bytes: fileBytes,
                name: metadata.filename
            });
        }

        return outputFiles;
    }

    // ─── Helper: write a packet as a PNG frame to FFmpeg VFS ───

    async #writeFramePNG(frameIndex: number, packetBytes: Uint8Array): Promise<void> {
        if (!this.#canvas || !this.#ctx || !this.#ffmpeg) return;

        const pixels = bytesToPixels(packetBytes);
        const pixelsCopy = new Uint8ClampedArray(pixels.length);
        pixelsCopy.set(pixels);
        const imageData = new ImageData(pixelsCopy, FRAME_WIDTH, FRAME_HEIGHT);
        this.#ctx.putImageData(imageData, 0, 0);

        const blob = await new Promise<Blob>((resolve, reject) => {
            this.#canvas!.toBlob((b) => {
                if (!b) return reject("Failed to create PNG frame.");
                resolve(b);
            }, "image/png");
        });

        const arrayBuf = await blob.arrayBuffer();
        await this.#ffmpeg!.writeFile(`frame_${frameIndex}.png`, new Uint8Array(arrayBuf));
    }

    // ─── Helper: decode a PNG file to RGBA pixel data ───

    async #pngToPixels(pngBytes: Uint8Array): Promise<Uint8ClampedArray | null> {
        if (!this.#canvas || !this.#ctx) return null;

        const blob = new Blob([pngBytes as BlobPart], { type: "image/png" });
        const url = URL.createObjectURL(blob);

        const image = new Image();
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject("Failed to load PNG frame.");
            image.src = url;
        });
        URL.revokeObjectURL(url);

        this.#canvas.width = FRAME_WIDTH;
        this.#canvas.height = FRAME_HEIGHT;
        this.#ctx.drawImage(image, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);

        const imgData = this.#ctx.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
        return imgData.data;
    }

}

export default ytStorageHandler;
