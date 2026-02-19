import type { FileFormat, FileData, FormatHandler, ConvertPathNode } from "../FormatHandler.js";
import handlers from "../handlers";
import { TraversionGraph } from "../TraversionGraph.js";

// Global state for the logic layer (to avoid re-initializing)
let supportedFormatCache = new Map<string, FileFormat[]>();
const traversionGraph = new TraversionGraph();
let allOptions: Array<{ format: FileFormat, handler: FormatHandler }> = [];

export interface ConversionOption {
    format: FileFormat;
    handler: FormatHandler;
    index: number; // useful for React keys or selection
}

export async function initializeConversionSystem(): Promise<ConversionOption[]> {
    // 1. Try to load cache
    try {
        const cacheJSON = await fetch("cache.json").then(r => r.json());
        supportedFormatCache = new Map(cacheJSON);
    } catch {
        console.warn("Missing supported format precache.");
    }

    // 2. Initialize handlers and build options
    allOptions = [];

    for (const handler of handlers) {
        if (!supportedFormatCache.has(handler.name)) {
            try {
                await Promise.race([
                    handler.init(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${handler.name}`)), 10000))
                ]);
            } catch (e) {
                console.warn(`Handler "${handler.name}" failed to init:`, e);
                continue;
            }
            if (handler.supportedFormats) {
                supportedFormatCache.set(handler.name, handler.supportedFormats);
            }
        }

        const supportedFormats = supportedFormatCache.get(handler.name);
        if (!supportedFormats) continue;

        for (const format of supportedFormats) {
            if (!format.mime) continue;
            allOptions.push({ format, handler });
        }
    }

    // 3. Init graph
    traversionGraph.init(supportedFormatCache, handlers);

    return allOptions.map((opt, i) => ({ ...opt, index: i }));
}

export function getAllOptions() {
    return allOptions.map((opt, i) => ({ ...opt, index: i }));
}

async function attemptConvertPath(files: FileData[], path: ConvertPathNode[]): Promise<{ files: FileData[], path: ConvertPathNode[] } | null> {
    for (let i = 0; i < path.length - 1; i++) {
        const handler = path[i + 1].handler;
        try {
            let supportedFormats = supportedFormatCache.get(handler.name);
            if (!handler.ready) {
                try {
                    await handler.init();
                } catch (_) { return null; }
                if (handler.supportedFormats) {
                    supportedFormatCache.set(handler.name, handler.supportedFormats);
                    supportedFormats = handler.supportedFormats;
                }
            }
            if (!supportedFormats) throw `Handler "${handler.name}" doesn't support any formats.`;

            const inputFormat = supportedFormats.find(c => c.mime === path[i].format.mime && c.from)!;

            files = (await Promise.all([
                handler.doConvert(files, inputFormat, path[i + 1].format),
                // Minimal delay to allow UI updates if needed, though mostly handled by React state now
                new Promise(resolve => setTimeout(resolve, 0))
            ]))[0];

            if (files.some(c => !c.bytes.length)) throw "Output is empty.";

        } catch (e) {
            console.error(handler.name, `${path[i].format.format} → ${path[i + 1].format.format}`, e);
            return null;
        }
    }
    return { files, path };
}

export async function convertFiles(
    inputFiles: File[],
    inputOption: ConversionOption,
    outputOption: ConversionOption,
    onStatusUpdate?: (status: string) => void
): Promise<{ files: FileData[], path: ConvertPathNode[] } | null> {

    const inputFormat = inputOption.format;
    const outputFormat = outputOption.format;

    // Prepare file data
    const inputFileData: FileData[] = [];
    for (const inputFile of inputFiles) {
        const inputBuffer = await inputFile.arrayBuffer();
        const inputBytes = new Uint8Array(inputBuffer);

        // Direct pass-through if formats match
        if (inputFormat.mime === outputFormat.mime) {
            // In a real app, we might just return the original file, 
            // but to match API signature we return FileData
            inputFileData.push({ name: inputFile.name, bytes: inputBytes });
            continue;
        }
        inputFileData.push({ name: inputFile.name, bytes: inputBytes });
    }

    // If pass-through/same format, we are done (but the caller expects "path" logic usually)
    // The original code handled this inside the loop by calling downloadFile directly.
    // Here we'll handle it by returning a dummy path or just the files.
    if (inputFormat.mime === outputFormat.mime) {
        return { files: inputFileData, path: [] };
    }

    onStatusUpdate?.("Finding conversion route...");

    // Graph traversal
    const fromNode: ConvertPathNode = { format: inputFormat, handler: inputOption.handler };
    const toNode: ConvertPathNode = { format: outputFormat, handler: outputOption.handler };

    // simpleMode logic was:
    // if (path.at(-1)?.handler === to.handler) path[path.length - 1] = to;
    // We'll pass `true` for simpleMode for now or make it a parameter if needed.
    // The original code used a global simpleMode boolean. 

    // We will assume 'simpleMode' is true for the graph search if we want broad compatibility, 
    // or pass it as an arg. Let's start with true.
    const isSimpleMode = true;

    for await (const path of traversionGraph.searchPath(fromNode, toNode, isSimpleMode)) {
        if (path.at(-1)?.handler === toNode.handler) {
            path[path.length - 1] = toNode;
        }

        onStatusUpdate?.(`Trying ${path.map(c => c.format.format).join(" → ")}...`);

        const attempt = await attemptConvertPath(inputFileData, path);
        if (attempt) return attempt;
    }

    return null;
}
