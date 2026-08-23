"use client";

import {
  AlertCircle,
  ArrowRight,
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  Code2,
  Cpu,
  Download,
  ExternalLink,
  FileArchive,
  FileImage,
  ImagePlus,
  Images,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import Image from "next/image";
import type { DragEvent as ReactDragEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  FALLBACK_BATCH_FILES,
  batchLimitForStreaming,
  reserveUniqueOutputName,
  validateFile,
} from "@/lib/file-rules";
import type { ExecutionProvider, ProcessedImage, ProcessingStage } from "@/lib/processing-types";
import { ProcessingError, ProcessorClient } from "@/lib/worker-client";

type QueueStatus = "ready" | "processing" | "complete" | "skipped" | "failed" | "canceled";

interface QueueItem {
  id: string;
  file: File;
  status: QueueStatus;
  stage?: ProcessingStage;
  detail: string;
  progress: number;
}

interface PreviewPair {
  beforeUrl: string;
  afterUrl: string;
  outputName: string;
  report: ProcessedImage["report"];
  blob: Blob;
}

type ModelState = "waiting" | "checking" | "verified" | "error";

interface RuntimeStatus {
  modelState: ModelState;
  modelProgress: number;
  modelDetail: string;
  provider: ExecutionProvider | null;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}

interface FileSystemFileHandleLike {
  createWritable(): Promise<WritableStream<Uint8Array>>;
}

declare global {
  interface Window {
    showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandleLike>;
  }
}

const STAGE_PROGRESS: Record<ProcessingStage, [number, number]> = {
  decode: [2, 10],
  detect: [10, 20],
  "model-download": [20, 48],
  reconstruct: [48, 82],
  encode: [82, 90],
  verify: [90, 100],
};

const STAGE_LABELS: Record<ProcessingStage, string> = {
  decode: "Reading photo",
  detect: "Finding date",
  "model-download": "Preparing local model",
  reconstruct: "Reconstructing pixels",
  encode: "Writing PNG",
  verify: "Verifying result",
};

function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function fileId(file: File): string {
  return `${crypto.randomUUID()}-${file.name}-${file.size}-${file.lastModified}`;
}

function subscribeToStaticCapability(): () => void {
  return () => undefined;
}

function getWebGpuSnapshot(): boolean {
  return Boolean((navigator as Navigator & { gpu?: unknown }).gpu);
}

function getServerWebGpuSnapshot(): boolean {
  return false;
}

function getStreamedZipSnapshot(): boolean {
  return typeof window.showSaveFilePicker === "function";
}

function isFileDrag(event: ReactDragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function statusIcon(item: QueueItem) {
  if (item.status === "processing") return <LoaderCircle className="spin" size={18} />;
  if (item.status === "complete") return <Check size={18} />;
  if (item.status === "skipped" || item.status === "failed") return <AlertCircle size={18} />;
  if (item.status === "canceled") return <CircleStop size={18} />;
  return <FileImage size={18} />;
}

export function CleanerApp() {
  const inputRef = useRef<HTMLInputElement>(null);
  const processorRef = useRef<ProcessorClient | null>(null);
  const canceledRef = useRef(false);
  const dragDepthRef = useRef(0);
  const previewRef = useRef<PreviewPair | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewPair | null>(null);
  const [lastDownload, setLastDownload] = useState<{ blob: Blob; name: string } | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>({
    modelState: "waiting",
    modelProgress: 0,
    modelDetail: "A saved model is checked—or a fresh one downloaded—when you start.",
    provider: null,
  });
  const hasWebGpu = useSyncExternalStore(
    subscribeToStaticCapability,
    getWebGpuSnapshot,
    getServerWebGpuSnapshot,
  );
  const supportsStreamedZip = useSyncExternalStore(
    subscribeToStaticCapability,
    getStreamedZipSnapshot,
    getServerWebGpuSnapshot,
  );
  const batchLimit = batchLimitForStreaming(supportsStreamedZip);
  const canAddFiles = !isRunning
    && queue.length < batchLimit
    && queue.every((item) => item.status === "ready");
  const remainingSlots = Math.max(0, batchLimit - queue.length);

  useEffect(() => {
    return () => {
      processorRef.current?.terminate("The page was closed.");
      if (previewRef.current) {
        URL.revokeObjectURL(previewRef.current.beforeUrl);
        URL.revokeObjectURL(previewRef.current.afterUrl);
      }
    };
  }, []);

  const updateItem = useCallback((id: string, change: Partial<QueueItem>) => {
    setQueue((current) => current.map((item) => (item.id === id ? { ...item, ...change } : item)));
  }, []);

  const resetPreview = useCallback(() => {
    if (previewRef.current) {
      URL.revokeObjectURL(previewRef.current.beforeUrl);
      URL.revokeObjectURL(previewRef.current.afterUrl);
    }
    previewRef.current = null;
    setPreview(null);
  }, []);

  const addFiles = useCallback(
    (incoming: File[]) => {
      setNotice(null);
      resetPreview();
      setLastDownload(null);
      const available = Math.max(0, batchLimit - queue.length);
      const accepted = incoming.slice(0, available);
      const next: QueueItem[] = [];
      const errors: string[] = [];

      for (const file of accepted) {
        const validation = validateFile(file);
        if (validation) {
          errors.push(`${file.name}: ${validation}`);
          continue;
        }
        next.push({
          id: fileId(file),
          file,
          status: "ready",
          detail: "Ready to process",
          progress: 0,
        });
      }

      if (incoming.length > available) {
        errors.push(`This browser can add ${batchLimit} photos per batch; ${available} slots were available.`);
      }
      if (errors.length > 0) setNotice(errors.slice(0, 3).join(" "));
      if (next.length > 0) setQueue((current) => [...current, ...next]);
    },
    [batchLimit, queue.length, resetPreview],
  );

  const openFilePicker = useCallback(() => {
    if (!canAddFiles) return;
    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.click();
    }
  }, [canAddFiles]);

  const handleDragEnter = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (!canAddFiles) return;
      dragDepthRef.current += 1;
      setIsDragging(true);
    },
    [canAddFiles],
  );

  const handleDragOver = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = canAddFiles ? "copy" : "none";
    },
    [canAddFiles],
  );

  const handleDragLeave = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (dragDepthRef.current === 0) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDragging(false);
      if (isRunning) return;
      if (!canAddFiles) {
        setNotice(`This browser supports ${batchLimit} photos per batch. Clear the list to start another.`);
        return;
      }
      addFiles(Array.from(event.dataTransfer.files));
    },
    [addFiles, batchLimit, canAddFiles, isRunning],
  );

  const clearQueue = useCallback(() => {
    if (isRunning) return;
    setQueue([]);
    setNotice(null);
    setLastDownload(null);
    resetPreview();
    if (inputRef.current) inputRef.current.value = "";
  }, [isRunning, resetPreview]);

  const removeItem = useCallback(
    (id: string) => {
      if (isRunning) return;
      setQueue((current) => current.filter((item) => item.id !== id));
      resetPreview();
    },
    [isRunning, resetPreview],
  );

  const completed = useMemo(() => queue.filter((item) => item.status === "complete").length, [queue]);
  const skipped = useMemo(
    () => queue.filter((item) => item.status === "skipped" || item.status === "failed").length,
    [queue],
  );
  const overallProgress = useMemo(() => {
    if (queue.length === 0) return 0;
    return Math.round(queue.reduce((sum, item) => sum + item.progress, 0) / queue.length);
  }, [queue]);

  const modeLabel = runtimeStatus.provider === "webgpu"
    ? "WebGPU active"
    : runtimeStatus.provider === "wasm"
      ? "Compatibility mode active"
      : hasWebGpu
        ? "WebGPU available"
        : "Compatibility mode";
  const modeDetail = runtimeStatus.provider
    ? "Actual local mode selected for this tab."
    : hasWebGpu
      ? "GPU acceleration will be tried first."
      : "Private WebAssembly processing; it may take longer.";
  const modelLabel = ({
    waiting: "Not checked yet",
    checking: "Preparing model",
    verified: "Integrity verified",
    error: "Model unavailable",
  } satisfies Record<ModelState, string>)[runtimeStatus.modelState];
  const modelPercent = Math.round(runtimeStatus.modelProgress * 100);

  const processOne = useCallback(
    async (item: QueueItem): Promise<ProcessedImage | null> => {
      if (canceledRef.current) return null;
      let lastStage: ProcessingStage | null = null;
      let verifiedDuringAttempt = false;
      updateItem(item.id, { status: "processing", detail: "Starting…", progress: 1 });
      if (!processorRef.current) {
        processorRef.current = new ProcessorClient();
        setRuntimeStatus((current) => ({ ...current, provider: null }));
      }
      try {
        const result = await processorRef.current.process(item.id, item.file, true, (message) => {
          lastStage = message.stage;
          if (message.stage === "model-download") {
            if (message.modelVerified) verifiedDuringAttempt = true;
            setRuntimeStatus((current) => ({
              ...current,
              modelState: message.modelVerified ? "verified" : "checking",
              modelProgress: Math.min(1, Math.max(0, message.progress ?? current.modelProgress)),
              modelDetail: message.detail ?? "Preparing the private restoration model.",
            }));
          }
          if (message.provider) {
            verifiedDuringAttempt = true;
            setRuntimeStatus((current) => ({
              ...current,
              modelState: "verified",
              modelProgress: 1,
              modelDetail: current.modelState === "verified"
                ? current.modelDetail
                : "SHA-256 matched before the model was used.",
              provider: message.provider ?? current.provider,
            }));
          }
          const [start, end] = STAGE_PROGRESS[message.stage];
          const stageProgress = message.progress ?? 0;
          updateItem(item.id, {
            stage: message.stage,
            detail: message.detail ?? STAGE_LABELS[message.stage],
            progress: Math.round(start + (end - start) * stageProgress),
          });
        });
        updateItem(item.id, {
          status: "complete",
          detail: "Verified and ready",
          progress: 100,
        });
        setRuntimeStatus((current) => ({
          ...current,
          modelState: "verified",
          modelProgress: 1,
          modelDetail: current.modelState === "verified"
            ? current.modelDetail
            : "SHA-256 matched before the model was used.",
          provider: result.report.executionProvider,
        }));
        return result;
      } catch (error) {
        if (canceledRef.current) {
          updateItem(item.id, { status: "canceled", detail: "Canceled", progress: 0 });
          return null;
        }
        const message = error instanceof Error ? error.message : "This photo could not be processed.";
        if (lastStage === "model-download" && !verifiedDuringAttempt) {
          setRuntimeStatus((current) => ({
            ...current,
            modelState: "error",
            modelProgress: 0,
            modelDetail: message,
            provider: null,
          }));
        }
        updateItem(item.id, {
          status: error instanceof ProcessingError && error.code === "not-found" ? "skipped" : "failed",
          detail: message,
          progress: 0,
        });
        return null;
      }
    },
    [updateItem],
  );

  const beginProcessing = useCallback(async () => {
    const readyItems = queue.filter((item) => item.status === "ready");
    if (readyItems.length === 0 || isRunning) return;
    const archiveName = `date-stamp-cleaner-${new Date().toISOString().slice(0, 10)}.zip`;
    let bulkSaveHandle: FileSystemFileHandleLike | null = null;
    if (readyItems.length > 1 && typeof window.showSaveFilePicker === "function") {
      try {
        bulkSaveHandle = await window.showSaveFilePicker({
          suggestedName: archiveName,
          types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }],
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          setNotice("Nothing was changed. Choose Remove date stamps when you are ready.");
          return;
        }
        setNotice("The ZIP save location could not be opened. Check your browser permissions and try again.");
        return;
      }
    }
    setNotice(null);
    setLastDownload(null);
    resetPreview();
    canceledRef.current = false;
    dragDepthRef.current = 0;
    setIsDragging(false);
    setIsRunning(true);

    try {
      if (readyItems.length === 1) {
        const result = await processOne(readyItems[0]);
        if (result && !canceledRef.current) {
          const nextPreview: PreviewPair = {
            beforeUrl: URL.createObjectURL(readyItems[0].file),
            afterUrl: URL.createObjectURL(result.blob),
            outputName: result.outputName,
            report: result.report,
            blob: result.blob,
          };
          previewRef.current = nextPreview;
          setPreview(nextPreview);
          setLastDownload({ blob: result.blob, name: result.outputName });
          triggerDownload(result.blob, result.outputName);
          setNotice("Your verified PNG download has started.");
        }
      } else {
        const canStreamToDisk = bulkSaveHandle !== null;
        if (!canStreamToDisk && readyItems.length > FALLBACK_BATCH_FILES) {
          throw new Error(
            `This browser can safely package up to ${FALLBACK_BATCH_FILES} photos in memory. Use current Chrome or Edge for larger streamed batches.`,
          );
        }

        const outputs = async function* () {
          const usedOutputNames = new Set<string>();
          for (const item of readyItems) {
            if (canceledRef.current) return;
            const result = await processOne(item);
            if (result) {
              yield {
                name: reserveUniqueOutputName(result.outputName, usedOutputNames),
                input: result.blob,
                size: result.blob.size,
                lastModified: Date.now(),
              };
            }
          }
        };
        const { downloadZip, makeZip } = await import("client-zip");

        if (bulkSaveHandle) {
          const writable = await bulkSaveHandle.createWritable();
          await makeZip(outputs()).pipeTo(writable);
          if (!canceledRef.current) setNotice("Your repaired PNG archive was saved to the location you chose.");
        } else {
          const archive = await downloadZip(outputs()).blob();
          if (!canceledRef.current) {
            setLastDownload({ blob: archive, name: archiveName });
            triggerDownload(archive, archiveName);
            setNotice("Your repaired PNG archive download has started.");
          }
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setNotice("Nothing was changed. Choose Remove date stamps when you are ready.");
      } else if (!canceledRef.current) {
        setNotice(error instanceof Error ? error.message : "The batch could not be completed.");
      }
    } finally {
      setIsRunning(false);
    }
  }, [isRunning, processOne, queue, resetPreview]);

  const cancelProcessing = useCallback(() => {
    canceledRef.current = true;
    processorRef.current?.terminate();
    processorRef.current = null;
    dragDepthRef.current = 0;
    setIsDragging(false);
    setRuntimeStatus({
      modelState: "waiting",
      modelProgress: 0,
      modelDetail: "Canceled safely; the model will be checked again on retry.",
      provider: null,
    });
    setQueue((current) =>
      current.map((item) =>
        item.status === "processing" || item.status === "ready"
          ? { ...item, status: "canceled", detail: "Canceled", progress: 0 }
          : item,
      ),
    );
    setNotice("Processing stopped. Clear the list whenever you want to release this tab’s file access.");
    setIsRunning(false);
  }, []);

  const retryIncomplete = useCallback(() => {
    if (isRunning) return;
    processorRef.current?.terminate("Restarting the processor.");
    processorRef.current = null;
    setRuntimeStatus({
      modelState: "waiting",
      modelProgress: 0,
      modelDetail: "The saved model will be checked again when processing restarts.",
      provider: null,
    });
    setQueue((current) =>
      current.map((item) =>
        item.status === "complete"
          ? item
          : { ...item, status: "ready", detail: "Ready to retry", progress: 0, stage: undefined },
      ),
    );
    setNotice(null);
  }, [isRunning]);

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Date Stamp Cleaner home">
          <span className="brand-mark" aria-hidden="true"><Camera size={19} /></span>
          <span>Date Stamp Cleaner</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#privacy">Privacy</a>
          <a className="github-link" href="https://github.com/jpattison54319/Sony-Cyber-shot-Date-Removal" target="_blank" rel="noreferrer">
            <Code2 size={16} /><span>Source</span>
          </a>
        </nav>
        <span className="local-badge"><LockKeyhole size={15} /> On-device</span>
      </header>

      <section className="hero" id="top">
        <div className="eyebrow"><span className="status-light" /> Tuned for orange camera dates</div>
        <h1>Keep the photo.<br /><span>Lose the timestamp.</span></h1>
        <p className="hero-copy">
          Remove the orange <strong>MM DD YYYY</strong> date added by many Sony Cyber-shot cameras.
          Your photos are reconstructed privately in this browser and never uploaded.
        </p>

        <section
          className={`workspace-shell ${isDragging ? "is-dragging" : ""}`}
          aria-labelledby="workspace-title"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <input
            ref={inputRef}
            className="visually-hidden"
            type="file"
            accept="image/jpeg,image/png,.jpg,.jpeg,.png"
            multiple
            aria-label="Choose one or more photos"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              addFiles(files);
            }}
          />
          <div className="workspace-topbar">
            <div>
              <span className="label" id="workspace-title">LOCAL WORKSPACE</span>
              <span className="ready"><span /> {isRunning ? `${overallProgress}% complete` : "Ready"}</span>
            </div>
            <span>LOCAL ONLY · JPG · PNG</span>
          </div>

          <div className="runtime-strip" role="group" aria-label="Local processing readiness">
            <div className={`runtime-item mode-${runtimeStatus.provider ?? (hasWebGpu ? "webgpu" : "wasm")}`}>
              <span className="runtime-icon" aria-hidden="true"><Cpu size={20} /></span>
              <span className="runtime-copy">
                <span className="runtime-label">PROCESSING MODE</span>
                <strong>{modeLabel}</strong>
                <span className="runtime-detail">{modeDetail}</span>
              </span>
            </div>
            <div className={`runtime-item model-${runtimeStatus.modelState}`}>
              <span className="runtime-icon" aria-hidden="true">
                {runtimeStatus.modelState === "checking" ? <LoaderCircle className="spin" size={20} /> :
                  runtimeStatus.modelState === "verified" ? <ShieldCheck size={20} /> :
                    runtimeStatus.modelState === "error" ? <AlertCircle size={20} /> : <Download size={20} />}
              </span>
              <span className="runtime-copy">
                <span className="runtime-label">RESTORATION MODEL</span>
                <span className="runtime-title-row">
                  <strong aria-live="polite">{modelLabel}</strong>
                  {runtimeStatus.modelState === "checking" && <b>{modelPercent}%</b>}
                </span>
                <span className="runtime-detail">{runtimeStatus.modelDetail}</span>
                {runtimeStatus.modelState === "checking" && (
                  <span
                    className="runtime-progress"
                    role="progressbar"
                    aria-label="Restoration model preparation"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={modelPercent}
                  >
                    <span style={{ width: `${modelPercent}%` }} />
                  </span>
                )}
              </span>
            </div>
          </div>

          {queue.length === 0 ? (
            <div className={`drop-zone ${isDragging ? "is-dragging" : ""}`}>
              <span className="upload-icon"><Upload size={26} strokeWidth={1.8} /></span>
              <span className="drop-title">Choose one photo or a whole batch</span>
              <button className="primary-button picker-button" type="button" onClick={openFilePicker}>
                <Images size={18} /> Choose photos
              </button>
              <span className="drop-copy desktop-drop-copy">or drag and drop JPG or PNG files here</span>
              <span className="drop-copy mobile-picker-copy">Select one photo or multiple photos from your library or Files.</span>
              <span className="file-hint">Up to {batchLimit} photos per batch · 30 MB each</span>
            </div>
          ) : (
            <div className="queue-panel">
              <div className="queue-heading">
                <div>
                  <span className="queue-kicker">{queue.length === 1 ? "ONE PHOTO" : `${queue.length} PHOTOS`}</span>
                  <h2>{isRunning ? "Removing date stamps" : completed > 0 ? "Processing complete" : "Ready to clean"}</h2>
                </div>
                {!isRunning && (
                  <div className="queue-heading-actions">
                    {canAddFiles && (
                      <button className="add-photos-button" type="button" onClick={openFilePicker}>
                        <ImagePlus size={17} /> Add photos
                      </button>
                    )}
                    <button className="icon-button" type="button" onClick={clearQueue} aria-label="Clear selected photos">
                      <Trash2 size={18} />
                    </button>
                  </div>
                )}
              </div>

              <div className="queue-progress" aria-hidden="true">
                <span style={{ width: `${overallProgress}%` }} />
              </div>

              <ul className="file-list" aria-label="Selected photos and processing status">
                {queue.map((item) => (
                  <li key={item.id} className={`file-row status-${item.status}`}>
                    <span className="file-status-icon" aria-hidden="true">{statusIcon(item)}</span>
                    <span className="file-details">
                      <strong title={item.file.name}>{item.file.name}</strong>
                      <span>{item.detail}</span>
                    </span>
                    <span className="file-meta">
                      {item.status === "processing" ? `${item.progress}%` : formatBytes(item.file.size)}
                    </span>
                    {item.status === "ready" && !isRunning && (
                      <button className="remove-file" type="button" onClick={() => removeItem(item.id)} aria-label={`Remove ${item.file.name}`}>
                        <X size={16} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>

              {canAddFiles && (
                <p className="queue-add-hint">
                  <span className="desktop-drop-copy">Drop more photos anywhere in this workspace, or choose Add photos.</span>
                  <span className="mobile-picker-copy">Choose Add photos to select more from your device.</span>
                  <small>{remainingSlots} {remainingSlots === 1 ? "slot" : "slots"} left in this batch</small>
                </p>
              )}

              <div className="queue-actions">
                {isRunning ? (
                  <button className="secondary-button danger" type="button" onClick={cancelProcessing}>
                    <CircleStop size={18} /> Stop safely
                  </button>
                ) : queue.some((item) => item.status === "ready") ? (
                  <button className="primary-button" type="button" onClick={beginProcessing}>
                    <Sparkles size={18} /> Remove date {queue.length === 1 ? "stamp" : "stamps"}
                    <ArrowRight size={18} />
                  </button>
                ) : (
                  <>
                    {skipped > 0 && completed < queue.length && (
                      <button className="secondary-button" type="button" onClick={retryIncomplete}>
                        <RefreshCw size={17} /> Retry incomplete
                      </button>
                    )}
                    {lastDownload && (
                      <button className="primary-button" type="button" onClick={() => triggerDownload(lastDownload.blob, lastDownload.name)}>
                        <Download size={18} /> Download again
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          <div className="privacy-row">
            <ShieldCheck size={18} />
            <p><strong>Private by design.</strong> Files stay on your device from selection to download.</p>
          </div>
        </section>

        {notice && (
          <div className="notice" role="status" aria-live="polite">
            {completed > 0 ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
            <span>{notice}</span>
          </div>
        )}

        {(runtimeStatus.provider === "wasm" || (!runtimeStatus.provider && !hasWebGpu)) && (
          <div className="compatibility-note">
            <Cpu size={17} />
            <span>WebAssembly compatibility mode stays private, but may take longer. A current desktop Chrome or Edge is best for larger batches.</span>
          </div>
        )}
      </section>

      {preview && (
        <section className="result-section" aria-labelledby="result-heading">
          <div className="section-heading result-heading-row">
            <div>
              <span className="section-kicker">VERIFIED RESULT</span>
              <h2 id="result-heading">Only the date area changed.</h2>
            </div>
            <button className="secondary-button" type="button" onClick={() => triggerDownload(preview.blob, preview.outputName)}>
              <Download size={17} /> Download PNG
            </button>
          </div>
          <div className="comparison-grid">
            <figure>
              <div className="image-frame"><Image src={preview.beforeUrl} alt="Original selected photo" fill unoptimized sizes="(max-width: 760px) 100vw, 50vw" /></div>
              <figcaption>Before</figcaption>
            </figure>
            <figure>
              <div className="image-frame"><Image src={preview.afterUrl} alt="Photo with the camera date reconstructed" fill unoptimized sizes="(max-width: 760px) 100vw, 50vw" /></div>
              <figcaption><Check size={15} /> After · verified PNG</figcaption>
            </figure>
          </div>
          <div className="audit-strip">
            <div><strong>0</strong><span>pixels changed outside the mask</span></div>
            <div><strong>{preview.report.maskPixels.toLocaleString()}</strong><span>pixels in the edit boundary</span></div>
            <div><strong>{preview.report.executionProvider.toUpperCase()}</strong><span>local processing mode</span></div>
          </div>
        </section>
      )}

      <section className="steps-section" id="how-it-works" aria-labelledby="steps-heading">
        <div className="section-heading centered-heading">
          <span className="section-kicker">CLEAR BY DESIGN</span>
          <h2 id="steps-heading">Three steps. Nothing leaves your device.</h2>
          <p>The original stays untouched. You receive a new lossless PNG only after every safety check passes.</p>
        </div>
        <div className="step-grid">
          <article>
            <span className="step-number">01</span><div className="step-icon"><Images size={22} /></div>
            <h3>Choose your photos</h3>
            <p>Select one image or a whole camera folder. JPG, JPEG, and opaque PNG files are supported.</p>
          </article>
          <article>
            <span className="step-number">02</span><div className="step-icon"><Sparkles size={22} /></div>
            <h3>Reconstruct locally</h3>
            <p>The camera-specific detector finds the eight orange glyphs, then LaMa rebuilds only their masked area.</p>
          </article>
          <article>
            <span className="step-number">03</span><div className="step-icon"><Download size={22} /></div>
            <h3>Download verified PNGs</h3>
            <p>Single photos download directly. Batches are packaged as one PNG-only ZIP after processing.</p>
          </article>
        </div>
      </section>

      <section className="privacy-section" id="privacy" aria-labelledby="privacy-heading">
        <div className="privacy-card">
          <div className="privacy-copy">
            <span className="privacy-symbol"><LockKeyhole size={26} /></span>
            <span className="section-kicker">PRIVACY YOU CAN UNDERSTAND</span>
            <h2 id="privacy-heading">Your photos have nowhere to go.</h2>
            <p>
              There is no upload endpoint, account, gallery, analytics tracker, or photo database. Processing happens in a temporary browser worker, and only the verified restoration model may be cached for future visits.
            </p>
            <a href="https://github.com/jpattison54319/Sony-Cyber-shot-Date-Removal" target="_blank" rel="noreferrer">
              Inspect the open-source workflow <ExternalLink size={15} />
            </a>
          </div>
          <ul className="privacy-checks">
            <li><Check size={17} /><span><strong>No photo uploads</strong>Your files are never sent to this site or a third party.</span></li>
            <li><Check size={17} /><span><strong>Temporary tab access</strong>Selected files stay available only until you clear the list or close the page.</span></li>
            <li><Check size={17} /><span><strong>Fail-closed detection</strong>If the supported date is not found confidently, no edit is produced.</span></li>
            <li><Check size={17} /><span><strong>Exact edit boundary</strong>Every decoded RGB pixel outside the mask must remain unchanged.</span></li>
          </ul>
        </div>
      </section>

      <section className="limitation-section" aria-labelledby="limitation-heading">
        <div className="limitation-icon"><FileArchive size={22} /></div>
        <div>
          <h2 id="limitation-heading">An honest note about restoration</h2>
          <p>
            A printed timestamp covered the original scene pixels, so no tool can recover their historical ground truth. This workflow reconstructs that small region and preserves every decoded RGB pixel outside its recorded mask exactly.
          </p>
        </div>
        <a href="https://github.com/jpattison54319/Sony-Cyber-shot-Date-Removal#how-it-works" target="_blank" rel="noreferrer">Technical details <ChevronRight size={15} /></a>
      </section>

      <footer>
        <div className="footer-brand"><span className="brand-mark"><Camera size={18} /></span><span><strong>Date Stamp Cleaner</strong><small>Private, local camera-date removal.</small></span></div>
        <p>Not affiliated with Sony. Cyber-shot is referenced only to describe compatible camera timestamps.</p>
        <a href="https://github.com/jpattison54319/Sony-Cyber-shot-Date-Removal" target="_blank" rel="noreferrer"><Code2 size={16} /> GitHub</a>
      </footer>
    </main>
  );
}
