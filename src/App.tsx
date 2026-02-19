import { useEffect, useState, useMemo } from 'react'
import { initializeConversionSystem, convertFiles, type ConversionOption } from '@/logic/conversion'
import { cn } from '@/lib/utils'
import { UploadIcon, ArrowRightIcon, CheckIcon, Loader2Icon, AlertCircleIcon, FileIcon, XIcon } from 'lucide-react'
import normalizeMimeType from './normalizeMimeType'

type AppState = 'idle' | 'converting' | 'success' | 'error'

export default function App() {
    const [options, setOptions] = useState<ConversionOption[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [initError, setInitError] = useState<string | null>(null)

    const [selectedFiles, setSelectedFiles] = useState<File[]>([])
    const [inputOption, setInputOption] = useState<ConversionOption | null>(null)
    const [outputOption, setOutputOption] = useState<ConversionOption | null>(null)

    const [simpleMode, setSimpleMode] = useState(true)
    const [inputSearch, setInputSearch] = useState('')
    const [outputSearch, setOutputSearch] = useState('')

    const [appState, setAppState] = useState<AppState>('idle')
    const [statusMessage, setStatusMessage] = useState('')

    useEffect(() => {
        initializeConversionSystem()
            .then(opts => {
                setOptions(opts)
                setIsLoading(false)
            })
            .catch(err => {
                setInitError(String(err))
                setIsLoading(false)
            })
    }, [])

    // Auto-detect input format
    useEffect(() => {
        if (selectedFiles.length > 0 && options.length > 0) {
            const file = selectedFiles[0]
            const mime = normalizeMimeType(file.type) || ''
            const ext = file.name.split('.').pop()?.toLowerCase()
            const found = options.find(o => {
                if (mime && o.format.mime === mime) return true
                if (ext && o.format.format.toLowerCase() === ext) return true
                return false
            })
            if (found?.format.from) setInputOption(found)
        }
    }, [selectedFiles, options])

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files?.length) setSelectedFiles(Array.from(e.target.files))
    }

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        if (e.dataTransfer.files?.length) setSelectedFiles(Array.from(e.dataTransfer.files))
    }

    const handleConvert = async () => {
        if (!inputOption || !outputOption || !selectedFiles.length) return
        setAppState('converting')
        setStatusMessage('Starting conversion...')
        try {
            const result = await convertFiles(selectedFiles, inputOption, outputOption, setStatusMessage)
            if (result) {
                setAppState('success')
                setStatusMessage(`Done! ${result.files.length} file(s) converted.`)
                for (const file of result.files) {
                    const blob = new Blob([file.bytes as BlobPart], { type: outputOption.format.mime })
                    const link = document.createElement('a')
                    link.href = URL.createObjectURL(blob)
                    link.download = file.name
                    link.click()
                }
            } else {
                setAppState('error')
                setStatusMessage('No conversion path found for these formats.')
            }
        } catch (e) {
            setAppState('error')
            setStatusMessage('An unexpected error occurred.')
            console.error(e)
        }
    }

    const filteredInput = useMemo(() => {
        let list = options.filter(o => o.format.from)
        if (simpleMode) {
            const seen = new Set<string>()
            list = list.filter(o => {
                const key = `${o.format.mime}|${o.format.format}`
                return seen.has(key) ? false : (seen.add(key), true)
            })
        }
        const term = inputSearch.toLowerCase()
        if (term) list = list.filter(o =>
            o.format.format.toLowerCase().includes(term) ||
            o.format.name.toLowerCase().includes(term)
        )
        return list
    }, [options, simpleMode, inputSearch])

    const filteredOutput = useMemo(() => {
        let list = options.filter(o => o.format.to)
        if (simpleMode) {
            const seen = new Set<string>()
            list = list.filter(o => {
                const key = `${o.format.mime}|${o.format.format}`
                return seen.has(key) ? false : (seen.add(key), true)
            })
        }
        const term = outputSearch.toLowerCase()
        if (term) list = list.filter(o =>
            o.format.format.toLowerCase().includes(term) ||
            o.format.name.toLowerCase().includes(term)
        )
        return list
    }, [options, simpleMode, outputSearch])

    const canConvert = inputOption && outputOption && selectedFiles.length > 0

    return (
        <div className="h-screen flex flex-col bg-[#0a0a0a] text-white overflow-hidden" style={{ fontFamily: "'Inter', sans-serif" }}>

            {/* Header */}
            <header className="flex-none flex items-center justify-between px-5 h-11 border-b border-white/[0.06]">
                <span className="text-sm font-medium tracking-tight">Convert</span>
                <button
                    onClick={() => setSimpleMode(!simpleMode)}
                    className="text-xs text-white/30 hover:text-white/60 transition-colors"
                >
                    {simpleMode ? 'Advanced' : 'Simple'}
                </button>
            </header>

            <div className="flex-1 flex flex-col overflow-hidden max-w-5xl w-full mx-auto px-5 py-4 gap-3">

                {/* Drop zone */}
                <div
                    role="button"
                    tabIndex={0}
                    className={cn(
                        "flex-none flex items-center gap-3 px-4 py-3 rounded-lg border cursor-pointer transition-colors",
                        "border-white/[0.08] hover:border-white/[0.15] bg-white/[0.02] hover:bg-white/[0.04]",
                        selectedFiles.length > 0 && "border-white/[0.15]"
                    )}
                    onDragOver={e => { e.preventDefault(); e.stopPropagation() }}
                    onDrop={handleDrop}
                    onClick={() => document.getElementById('file-input')?.click()}
                    onKeyDown={e => e.key === 'Enter' && document.getElementById('file-input')?.click()}
                >
                    {selectedFiles.length > 0 ? (
                        <>
                            <FileIcon className="w-4 h-4 text-white/40 shrink-0" />
                            <span className="text-sm text-white/80 truncate">{selectedFiles[0].name}</span>
                            {selectedFiles.length > 1 && (
                                <span className="text-xs text-white/30 shrink-0">+{selectedFiles.length - 1} more</span>
                            )}
                            <button
                                className="ml-auto text-white/20 hover:text-white/50 transition-colors shrink-0"
                                onClick={e => { e.stopPropagation(); setSelectedFiles([]); setInputOption(null) }}
                            >
                                <XIcon className="w-3.5 h-3.5" />
                            </button>
                        </>
                    ) : (
                        <>
                            <UploadIcon className="w-4 h-4 text-white/20 shrink-0" />
                            <span className="text-sm text-white/30">Drop a file or click to browse</span>
                        </>
                    )}
                    <input id="file-input" type="file" multiple className="hidden" onChange={handleFileSelect} />
                </div>

                {/* Format selectors */}
                <div className="flex-1 min-h-0">
                    {isLoading ? (
                        <div className="h-full flex items-center justify-center gap-2 text-white/30">
                            <Loader2Icon className="w-4 h-4 animate-spin" />
                            <span className="text-sm">Loading formats…</span>
                        </div>
                    ) : initError ? (
                        <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-400">
                            Failed to initialize: {initError}
                        </div>
                    ) : (
                        <div className="h-full grid grid-cols-[1fr_auto_1fr] gap-2">
                            <FormatList
                                label="From"
                                items={filteredInput}
                                selected={inputOption}
                                onSelect={setInputOption}
                                search={inputSearch}
                                onSearch={setInputSearch}
                                simpleMode={simpleMode}
                            />

                            {/* Arrow */}
                            <div className="flex items-center justify-center w-8">
                                <ArrowRightIcon className="w-3.5 h-3.5 text-white/15" />
                            </div>

                            <FormatList
                                label="To"
                                items={filteredOutput}
                                selected={outputOption}
                                onSelect={setOutputOption}
                                search={outputSearch}
                                onSearch={setOutputSearch}
                                simpleMode={simpleMode}
                            />
                        </div>
                    )}
                </div>

                {/* Bottom action bar */}
                {!isLoading && (
                    <div className="flex-none flex items-center justify-between py-1">
                        <div className="text-xs text-white/20">
                            {inputOption && outputOption
                                ? <><span className="text-white/50 font-mono">{inputOption.format.format.toUpperCase()}</span> → <span className="text-white/50 font-mono">{outputOption.format.format.toUpperCase()}</span></>
                                : 'Select input and output formats'
                            }
                        </div>
                        <button
                            disabled={!canConvert}
                            onClick={handleConvert}
                            className={cn(
                                "px-5 py-1.5 rounded-md text-sm font-medium transition-all",
                                canConvert
                                    ? "bg-white text-black hover:bg-white/90"
                                    : "bg-white/5 text-white/20 cursor-not-allowed"
                            )}
                        >
                            Convert
                        </button>
                    </div>
                )}
            </div>

            {/* Status overlay */}
            {appState !== 'idle' && (
                <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => {
                    if (appState === 'success' || appState === 'error') setAppState('idle')
                }}>
                    <div className="bg-[#111] border border-white/10 rounded-xl p-6 w-72 flex flex-col items-center gap-4 text-center" onClick={e => e.stopPropagation()}>
                        {appState === 'converting' && <Loader2Icon className="w-7 h-7 animate-spin text-white/40" />}
                        {appState === 'success' && (
                            <div className="w-10 h-10 rounded-full bg-green-500/10 flex items-center justify-center">
                                <CheckIcon className="w-5 h-5 text-green-500" />
                            </div>
                        )}
                        {appState === 'error' && (
                            <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
                                <AlertCircleIcon className="w-5 h-5 text-red-400" />
                            </div>
                        )}
                        <div>
                            <p className="text-sm font-medium mb-1">
                                {appState === 'converting' ? 'Converting…' : appState === 'success' ? 'Done' : 'Failed'}
                            </p>
                            <p className="text-xs text-white/40">{statusMessage}</p>
                        </div>
                        {(appState === 'success' || appState === 'error') && (
                            <button
                                onClick={() => setAppState('idle')}
                                className="text-xs text-white/30 hover:text-white/60 transition-colors"
                            >
                                Close
                            </button>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}

// ─── FormatList ───────────────────────────────────────────────────────────────

interface FormatListProps {
    label: string
    items: ConversionOption[]
    selected: ConversionOption | null
    onSelect: (opt: ConversionOption) => void
    search: string
    onSearch: (val: string) => void
    simpleMode: boolean
}

function FormatList({ label, items, selected, onSelect, search, onSearch, simpleMode }: FormatListProps) {
    return (
        <div className="flex flex-col h-full rounded-lg border border-white/[0.07] bg-white/[0.02] overflow-hidden">
            {/* Header */}
            <div className="flex-none px-3 pt-3 pb-2 border-b border-white/[0.06]">
                <p className="text-[11px] font-medium text-white/30 uppercase tracking-widest mb-2">{label}</p>
                <input
                    type="text"
                    placeholder="Filter…"
                    value={search}
                    onChange={e => onSearch(e.target.value)}
                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-md px-2.5 py-1.5 text-xs text-white/70 placeholder:text-white/20 outline-none focus:border-white/20 transition-colors"
                />
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto py-1">
                {items.length === 0 ? (
                    <p className="text-xs text-white/20 text-center py-8">No formats</p>
                ) : (
                    items.map((opt, i) => (
                        <button
                            key={i}
                            onClick={() => onSelect(opt)}
                            className={cn(
                                "w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors",
                                selected === opt
                                    ? "bg-white/[0.08] text-white"
                                    : "text-white/50 hover:bg-white/[0.04] hover:text-white/70"
                            )}
                        >
                            <span className="font-mono text-[11px] font-bold uppercase w-10 shrink-0 text-white/40">
                                {opt.format.format.slice(0, 4)}
                            </span>
                            <span className="text-xs truncate">
                                {simpleMode ? opt.format.name.split('(')[0].trim() : `${opt.format.name} · ${opt.handler.name}`}
                            </span>
                        </button>
                    ))
                )}
            </div>
        </div>
    )
}
