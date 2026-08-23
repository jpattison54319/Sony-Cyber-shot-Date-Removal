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
  Info,
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
import type { ChangeEvent, DragEvent as ReactDragEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  FALLBACK_BATCH_FILES,
  batchLimitForStreaming,
  reserveUniqueOutputName,
  validateFile,
} from "@/lib/file-rules";
import type { ExecutionProvider, ProcessedImage, ProcessingStage, WorkerResponse } from "@/lib/processing-types";
import { createSafeId } from "@/lib/safe-id";
import { ProcessingError, ProcessorClient } from "@/lib/worker-client";

type QueueStatus = "ready" | "processing" | "complete" | "skipped" | "failed" | "canceled";

type NoticeTone = "info" | "success" | "error";

interface Notice {
  tone: NoticeTone;
  text: string;
}

type ItemOutcome =
  | { status: "done"; result: ProcessedImage }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string }
  | { status: "canceled" };

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

// Mobile Safari and iOS Chrome routinely refuse a programmatic download that is
// not attached to a tap, and they never report the refusal. The caller always
// keeps the blob and an explicit save button, so a blocked attempt here is a
// silent no-op rather than a lost result.
function triggerDownload(blob: Blob, name: string): void {
  try {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.rel = "noopener";
    link.target = "_self";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    // The visible download button remains the reliable path.
  }
}

// Browsers surface a dropped model download as a bare "Failed to fetch", which
// tells a phone user nothing about what to do next.
function describeFailure(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message.trim() : "";
  if (!raw || /^(failed to fetch|load failed|network ?error)/i.test(raw)) return fallback;
  return raw;
}

function downloadLabel(name: string): string {
  return name.toLowerCase().endsWith(".zip") ? "Download ZIP" : "Download PNG";
}

function countPhrase(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
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
  const processorRef = useRef<ProcessorClient | null>(null);
  const modelPreparationRef = useRef<Promise<ExecutionProvider> | null>(null);
  const modelReadyRef = useRef(false);
  const canceledRef = useRef(false);
  const dragDepthRef = useRef(0);
  const previewRef = useRef<PreviewPair | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [preview, setPreview] = useState<PreviewPair | null>(null);
  const [lastDownload, setLastDownload] = useState<{ blob: Blob; name: string } | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>({
    modelState: "waiting",
    modelProgress: 0,
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

  useEffect(() => {
    return () => {
      const processor = processorRef.current;
      processorRef.current = null;
      modelPreparationRef.current = null;
      modelReadyRef.current = false;
      processor?.terminate("The page was closed.");
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

  const handleRuntimeProgress = useCallback(
    (message: Extract<WorkerResponse, { type: "progress" }>) => {
      if (message.stage === "model-download") {
        setRuntimeStatus((current) => ({
          ...current,
          modelState: message.modelVerified ? "verified" : "checking",
          modelProgress: Math.min(1, Math.max(0, message.progress ?? current.modelProgress)),
        }));
      }
      if (message.provider) {
        setRuntimeStatus({
          modelState: "verified",
          modelProgress: 1,
          provider: message.provider,
        });
      }
    },
    [],
  );

  const prepareModel = useCallback(() => {
    if (modelReadyRef.current || modelPreparationRef.current) return;
    setRuntimeStatus((current) => ({ ...current, modelState: "checking", modelProgress: 0 }));

    let processor: ProcessorClient;
    let preparation: Promise<ExecutionProvider>;
    try {
      processor = processorRef.current ?? new ProcessorClient();
      processorRef.current = processor;
      preparation = processor.prepare(
        `prepare-${crypto.randomUUID()}`,
        true,
        handleRuntimeProgress,
      );
      modelPreparationRef.current = preparation;
    } catch {
      processorRef.current = null;
      modelReadyRef.current = false;
      setRuntimeStatus({ modelState: "error", modelProgress: 0, provider: null });
      setNotice({ tone: "error", text: "The local processor could not start. Refresh and try again." });
      return;
    }

    void preparation
      .then((provider) => {
        if (processorRef.current !== processor) return;
        modelReadyRef.current = true;
        setRuntimeStatus({ modelState: "verified", modelProgress: 1, provider });
      })
      .catch((error) => {
        if (processorRef.current !== processor) return;
        if (!(error instanceof ProcessingError)) processorRef.current = null;
        modelReadyRef.current = false;
        setRuntimeStatus({ modelState: "error", modelProgress: 0, provider: null });
        setNotice({
          tone: "error",
          text: describeFailure(
            error,
            "The restoration model could not be downloaded. Check your connection; it is retried when you start.",
          ),
        });
      })
      .finally(() => {
        if (modelPreparationRef.current === preparation) modelPreparationRef.current = null;
      });
  }, [handleRuntimeProgress]);

  const cancelPendingModelPreparation = useCallback(() => {
    if (!modelPreparationRef.current) return;
    const processor = processorRef.current;
    processorRef.current = null;
    modelPreparationRef.current = null;
    modelReadyRef.current = false;
    processor?.terminate("Model preparation canceled.");
    setRuntimeStatus({ modelState: "waiting", modelProgress: 0, provider: null });
  }, []);

  const addFiles = useCallback(
    (incoming: File[]) => {
      resetPreview();
      setLastDownload(null);

      // A picker that hands back an empty list still has to say so. Reporting
      // nothing is what made a failed mobile selection look like a dead page.
      if (incoming.length === 0) {
        setNotice({
          tone: "error",
          text: "No photos came back from the picker. Choose them again, or pick a few at a time.",
        });
        return;
      }

      const available = Math.max(0, batchLimit - queue.length);
      const next: QueueItem[] = [];
      const rejected: string[] = [];
      let overflow = 0;

      // Every accepted photo gets its own row even when two selections look
      // identical: iOS reuses generic names for transcoded photos, so treating
      // a repeat as a duplicate would silently drop a photo the user chose.
      for (const file of incoming) {
        const validation = validateFile(file);
        if (validation) {
          rejected.push(`${file.name}: ${validation}`);
          continue;
        }
        if (next.length >= available) {
          overflow += 1;
          continue;
        }
        next.push({
          id: createSafeId("photo"),
          file,
          status: "ready",
          detail: "Photo selected · Ready",
          progress: 0,
        });
      }

      if (next.length > 0) {
        setQueue((current) => [...current, ...next]);
        window.setTimeout(prepareModel, 0);
      }

      const parts: string[] = [];
      if (next.length > 0) parts.push(`${countPhrase(next.length, "photo", "photos")} added.`);
      if (overflow > 0) {
        parts.push(`${countPhrase(overflow, "photo did", "photos did")} not fit the ${batchLimit}-photo limit for this browser.`);
      }
      parts.push(...rejected.slice(0, 2));
      if (rejected.length > 2) parts.push(`${countPhrase(rejected.length - 2, "other file", "other files")} could not be used.`);

      const skippedCount = overflow + rejected.length;
      setNotice({
        tone: next.length === 0 ? "error" : skippedCount > 0 ? "info" : "success",
        text: parts.join(" ") || "Those files could not be used. Choose a JPG, JPEG, or PNG photo.",
      });
    },
    [batchLimit, prepareModel, queue, resetPreview],
  );

  // The picker is the one step the user cannot see into, so every failure in
  // this handler has to surface instead of ending the event silently.
  const handleFileSelection = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      let files: File[] = [];
      try {
        files = Array.from(input.files ?? []);
      } catch {
        files = [];
      }
      try {
        // Clearing the value lets the same photo be chosen again later.
        input.value = "";
      } catch {
        // Some mobile browsers refuse the reset; the selection still stands.
      }
      try {
        addFiles(files);
      } catch (error) {
        setNotice({
          tone: "error",
          text: error instanceof Error
            ? `Those photos could not be added: ${error.message}`
            : "Those photos could not be added. Reload the page and try again.",
        });
      }
    },
    [addFiles],
  );

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
        setNotice({
          tone: "info",
          text: `This browser supports ${batchLimit} photos per batch. Clear the list to start another.`,
        });
        return;
      }
      addFiles(Array.from(event.dataTransfer.files));
    },
    [addFiles, batchLimit, canAddFiles, isRunning],
  );

  const clearQueue = useCallback(() => {
    if (isRunning) return;
    cancelPendingModelPreparation();
    setQueue([]);
    setNotice(null);
    setLastDownload(null);
    resetPreview();
  }, [cancelPendingModelPreparation, isRunning, resetPreview]);

  const removeItem = useCallback(
    (id: string) => {
      if (isRunning) return;
      if (queue.length === 1) cancelPendingModelPreparation();
      setQueue((current) => current.filter((item) => item.id !== id));
      resetPreview();
    },
    [cancelPendingModelPreparation, isRunning, queue.length, resetPreview],
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
    ? "WebGPU"
    : runtimeStatus.provider === "wasm"
      ? "Compatibility"
      : hasWebGpu
        ? "WebGPU available"
        : "Compatibility";
  const modelPercent = Math.round(runtimeStatus.modelProgress * 100);
  const modelLabel = ({
    waiting: "Starts after photo",
    checking: `Loading ${modelPercent}%`,
    verified: "Verified",
    error: "Download failed",
  } satisfies Record<ModelState, string>)[runtimeStatus.modelState];

  const processOne = useCallback(
    async (item: QueueItem): Promise<ItemOutcome> => {
      if (canceledRef.current) return { status: "canceled" };
      let lastStage: ProcessingStage | null = null;
      let verifiedDuringAttempt = false;
      updateItem(item.id, { status: "processing", detail: "Starting…", progress: 1 });
      if (!processorRef.current) {
        processorRef.current = new ProcessorClient();
        modelReadyRef.current = false;
        setRuntimeStatus((current) => ({ ...current, provider: null }));
      }
      try {
        const result = await processorRef.current.process(item.id, item.file, true, (message) => {
          lastStage = message.stage;
          if (message.modelVerified || message.provider) verifiedDuringAttempt = true;
          handleRuntimeProgress(message);
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
        modelReadyRef.current = true;
        setRuntimeStatus({
          modelState: "verified",
          modelProgress: 1,
          provider: result.report.executionProvider,
        });
        return { status: "done", result };
      } catch (error) {
        if (canceledRef.current) {
          updateItem(item.id, { status: "canceled", detail: "Canceled", progress: 0 });
          return { status: "canceled" };
        }
        const message = describeFailure(
          error,
          lastStage === "model-download"
            ? "The restoration model could not be downloaded. Check your connection and try again."
            : "This photo could not be processed.",
        );
        if (lastStage === "model-download" && !verifiedDuringAttempt) {
          setRuntimeStatus((current) => ({
            ...current,
            modelState: "error",
            modelProgress: 0,
            provider: null,
          }));
        }
        const status = error instanceof ProcessingError && error.code === "not-found" ? "skipped" : "failed";
        updateItem(item.id, { status, detail: message, progress: 0 });
        return { status, reason: message };
      }
    },
    [handleRuntimeProgress, updateItem],
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
          setNotice({ tone: "info", text: "Nothing was changed. Choose Remove date stamps when you are ready." });
          return;
        }
        // Streaming to a chosen file is a convenience, not a requirement. When
        // the picker is blocked by permissions, keep going with an in-memory
        // archive for any batch small enough to hold.
        if (readyItems.length > FALLBACK_BATCH_FILES) {
          setNotice({
            tone: "error",
            text: `The ZIP save location could not be opened, and ${readyItems.length} photos exceeds the `
              + `${FALLBACK_BATCH_FILES} this browser can package in memory. Remove some and try again.`,
          });
          return;
        }
        bulkSaveHandle = null;
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
        const outcome = await processOne(readyItems[0]);
        if (canceledRef.current) return;
        if (outcome.status === "done") {
          const { result } = outcome;
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
          setNotice({
            tone: "success",
            text: "Your verified PNG is ready. If the download did not start, use Download PNG below.",
          });
        } else if (outcome.status !== "canceled") {
          // Never end a run without saying what happened.
          setNotice({
            tone: outcome.status === "skipped" ? "info" : "error",
            text: `${outcome.reason} That photo was left untouched, so there is nothing to download.`,
          });
        }
      } else {
        const canStreamToDisk = bulkSaveHandle !== null;
        if (!canStreamToDisk && readyItems.length > FALLBACK_BATCH_FILES) {
          throw new Error(
            `This browser can safely package up to ${FALLBACK_BATCH_FILES} photos in memory. Use current Chrome or Edge for larger streamed batches.`,
          );
        }

        let cleaned = 0;
        let untouched = 0;
        const outputs = async function* () {
          const usedOutputNames = new Set<string>();
          for (const item of readyItems) {
            if (canceledRef.current) return;
            const outcome = await processOne(item);
            if (outcome.status === "done") {
              cleaned += 1;
              yield {
                name: reserveUniqueOutputName(outcome.result.outputName, usedOutputNames),
                input: outcome.result.blob,
                size: outcome.result.blob.size,
                lastModified: Date.now(),
              };
            } else if (outcome.status !== "canceled") {
              untouched += 1;
            }
          }
        };
        const { downloadZip, makeZip } = await import("client-zip");

        // An archive of nothing is worse than no archive: it looks like a
        // successful download and contains no photos.
        const leftOut = () => (untouched > 0
          ? ` ${countPhrase(untouched, "photo was", "photos were")} left untouched — see the list above.`
          : "");

        if (bulkSaveHandle) {
          const writable = await bulkSaveHandle.createWritable();
          await makeZip(outputs()).pipeTo(writable);
          if (canceledRef.current) return;
          setNotice(cleaned === 0
            ? { tone: "info", text: `No date stamps were removed, so the archive you chose is empty.${leftOut()}` }
            : {
              tone: "success",
              text: `${countPhrase(cleaned, "photo was", "photos were")} saved to the location you chose.${leftOut()}`,
            });
        } else {
          const archive = await downloadZip(outputs()).blob();
          if (canceledRef.current) return;
          if (cleaned === 0) {
            setNotice({ tone: "info", text: `No date stamps were removed, so there is nothing to download.${leftOut()}` });
          } else {
            setLastDownload({ blob: archive, name: archiveName });
            triggerDownload(archive, archiveName);
            setNotice({
              tone: "success",
              text: `${countPhrase(cleaned, "photo is", "photos are")} ready as a ZIP.${leftOut()}`
                + " If the download did not start, use Download ZIP below.",
            });
          }
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setNotice({ tone: "info", text: "Nothing was changed. Choose Remove date stamps when you are ready." });
      } else if (!canceledRef.current) {
        setNotice({ tone: "error", text: describeFailure(error, "The batch could not be completed.") });
      }
    } finally {
      setIsRunning(false);
    }
  }, [isRunning, processOne, queue, resetPreview]);

  const cancelProcessing = useCallback(() => {
    canceledRef.current = true;
    processorRef.current?.terminate();
    processorRef.current = null;
    modelPreparationRef.current = null;
    modelReadyRef.current = false;
    dragDepthRef.current = 0;
    setIsDragging(false);
    setRuntimeStatus({
      modelState: "waiting",
      modelProgress: 0,
      provider: null,
    });
    setQueue((current) =>
      current.map((item) =>
        item.status === "processing" || item.status === "ready"
          ? { ...item, status: "canceled", detail: "Canceled", progress: 0 }
          : item,
      ),
    );
    setNotice({
      tone: "info",
      text: "Processing stopped. Clear the list whenever you want to release this tab’s file access.",
    });
    setIsRunning(false);
  }, []);

  const retryIncomplete = useCallback(() => {
    if (isRunning) return;
    processorRef.current?.terminate("Restarting the processor.");
    processorRef.current = null;
    modelPreparationRef.current = null;
    modelReadyRef.current = false;
    setRuntimeStatus({
      modelState: "waiting",
      modelProgress: 0,
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
        <h1>Keep the photo.<br /><span>Lose the timestamp.</span></h1>
        <p className="hero-copy">Remove orange Sony Cyber-shot dates.</p>

        <section
          className={`workspace-shell ${isDragging ? "is-dragging" : ""}`}
          aria-labelledby="workspace-title"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="workspace-topbar">
            <div>
              <span className="label" id="workspace-title">LOCAL</span>
              <span className="ready"><span /> {isRunning ? `${overallProgress}% complete` : "Ready"}</span>
            </div>
          </div>

          <div className="runtime-strip" role="group" aria-label="Local processing readiness">
            <div className={`runtime-item mode-${runtimeStatus.provider ?? (hasWebGpu ? "webgpu" : "wasm")}`}>
              <span className="runtime-icon" aria-hidden="true"><Cpu size={18} /></span>
              <span className="runtime-copy">
                <span className="runtime-label">MODE</span>
                <strong>{modeLabel}</strong>
              </span>
            </div>
            <div className={`runtime-item model-${runtimeStatus.modelState}`}>
              <span className="runtime-icon" aria-hidden="true">
                {runtimeStatus.modelState === "checking" ? <LoaderCircle className="spin" size={18} /> :
                  runtimeStatus.modelState === "verified" ? <ShieldCheck size={18} /> :
                    runtimeStatus.modelState === "error" ? <AlertCircle size={18} /> : <Download size={18} />}
              </span>
              <span className="runtime-copy">
                <span className="runtime-label">MODEL</span>
                <strong aria-live="polite">{modelLabel}</strong>
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
              <span className="drop-title desktop-drop-copy">Drop photos here</span>
              <label className="primary-button picker-button file-picker-control">
                <Images size={18} /> Choose photos
                <input
                  className="native-file-input"
                  type="file"
                  accept="image/jpeg,image/png,.jpg,.jpeg,.png"
                  multiple
                  aria-label="Choose one or more photos"
                  onChange={handleFileSelection}
                />
              </label>
              <span className="file-hint">JPG or PNG · {batchLimit} max</span>
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
                      <label className="add-photos-button file-picker-control">
                        <ImagePlus size={17} /> Add photos
                        <input
                          className="native-file-input"
                          type="file"
                          accept="image/jpeg,image/png,.jpg,.jpeg,.png"
                          multiple
                          aria-label="Add one or more photos"
                          onChange={handleFileSelection}
                        />
                      </label>
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
                        <Download size={18} /> {downloadLabel(lastDownload.name)}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {notice && (
            <div className={`notice notice-${notice.tone}`} role="status" aria-live="polite">
              {notice.tone === "success"
                ? <CheckCircle2 size={18} />
                : notice.tone === "info"
                  ? <Info size={18} />
                  : <AlertCircle size={18} />}
              <span>{notice.text}</span>
            </div>
          )}

          <div className="privacy-row">
            <ShieldCheck size={18} />
            <p>Photos never leave this device.</p>
          </div>
        </section>

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
          <h2 id="steps-heading">Choose. Clean. Download.</h2>
        </div>
        <div className="step-grid">
          <article>
            <span className="step-number">01</span><div className="step-icon"><Images size={22} /></div>
            <h3>Choose photos</h3>
            <p>JPG or PNG. One or many.</p>
          </article>
          <article>
            <span className="step-number">02</span><div className="step-icon"><Sparkles size={22} /></div>
            <h3>Remove dates</h3>
            <p>Runs on your device.</p>
          </article>
          <article>
            <span className="step-number">03</span><div className="step-icon"><Download size={22} /></div>
            <h3>Download</h3>
            <p>PNG or ZIP, automatically.</p>
          </article>
        </div>
      </section>

      <section className="privacy-section" id="privacy" aria-labelledby="privacy-heading">
        <div className="privacy-card">
          <span className="privacy-symbol"><LockKeyhole size={24} /></span>
          <div className="privacy-copy">
            <h2 id="privacy-heading">Your photos stay here.</h2>
            <p>No uploads. No accounts. No analytics.</p>
          </div>
          <a href="https://github.com/jpattison54319/Sony-Cyber-shot-Date-Removal" target="_blank" rel="noreferrer">
            View source <ExternalLink size={15} />
          </a>
        </div>
      </section>

      <section className="limitation-section" aria-labelledby="limitation-heading">
        <div className="limitation-icon"><FileArchive size={22} /></div>
        <div>
          <h2 id="limitation-heading">Reconstructed, not recovered</h2>
          <p>The covered area is rebuilt. Pixels outside it stay unchanged.</p>
        </div>
        <a href="https://github.com/jpattison54319/Sony-Cyber-shot-Date-Removal#how-it-works" target="_blank" rel="noreferrer">Technical details <ChevronRight size={15} /></a>
      </section>

      <footer>
        <div className="footer-brand"><span className="brand-mark"><Camera size={18} /></span><strong>Date Stamp Cleaner</strong></div>
        <p>Not affiliated with Sony. Cyber-shot is referenced only to describe compatible camera timestamps.</p>
        <a href="https://github.com/jpattison54319/Sony-Cyber-shot-Date-Removal" target="_blank" rel="noreferrer"><Code2 size={16} /> GitHub</a>
      </footer>
    </main>
  );
}
