import type { ExecutionProvider, ProcessedImage, WorkerResponse } from "./processing-types";

interface PendingRequest {
  resolve: (result: ProcessedImage) => void;
  reject: (error: Error) => void;
  onProgress: (message: Extract<WorkerResponse, { type: "progress" }>) => void;
}

interface PendingPreparation {
  resolve: (provider: ExecutionProvider) => void;
  reject: (error: Error) => void;
  onProgress: (message: Extract<WorkerResponse, { type: "progress" }>) => void;
}

export class ProcessingError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ProcessingError";
  }
}

export class ProcessorClient {
  private readonly worker: Worker;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly preparations = new Map<string, PendingPreparation>();
  private closed = false;

  constructor() {
    this.worker = new Worker(new URL("../workers/processor.worker.ts", import.meta.url), {
      type: "module",
      name: "date-stamp-processor",
    });
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleWorkerError);
  }

  process(
    id: string,
    file: File,
    preferWebGpu: boolean,
    onProgress: PendingRequest["onProgress"],
  ): Promise<ProcessedImage> {
    if (this.closed) return Promise.reject(new Error("The private image processor must be restarted."));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ type: "process", id, file, preferWebGpu });
    });
  }

  prepare(
    id: string,
    preferWebGpu: boolean,
    onProgress: PendingPreparation["onProgress"],
  ): Promise<ExecutionProvider> {
    if (this.closed) return Promise.reject(new Error("The private image processor must be restarted."));
    return new Promise((resolve, reject) => {
      this.preparations.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ type: "prepare-model", id, preferWebGpu });
    });
  }

  terminate(reason = "Processing was canceled."): void {
    this.closed = true;
    this.worker.terminate();
    for (const request of this.pending.values()) request.reject(new Error(reason));
    for (const preparation of this.preparations.values()) preparation.reject(new Error(reason));
    this.pending.clear();
    this.preparations.clear();
  }

  private handleMessage = (event: MessageEvent<WorkerResponse>): void => {
    const message = event.data;
    const request = this.pending.get(message.id);
    const preparation = this.preparations.get(message.id);
    if (!request && !preparation) return;
    if (message.type === "progress") {
      (request ?? preparation)?.onProgress(message);
      return;
    }
    if (message.type === "prepared") {
      this.preparations.delete(message.id);
      preparation?.resolve(message.provider);
      return;
    }
    if (preparation) {
      this.preparations.delete(message.id);
      preparation.reject(
        new ProcessingError(
          message.type === "error" ? message.message : "Model preparation failed.",
          message.type === "error" ? message.code : "processing-failed",
        ),
      );
      return;
    }
    if (!request) return;
    this.pending.delete(message.id);
    if (message.type === "result") request.resolve(message.result);
    else request.reject(new ProcessingError(message.message, message.code));
  };

  private handleWorkerError = (): void => {
    this.closed = true;
    this.worker.terminate();
    for (const request of this.pending.values()) {
      request.reject(new Error("The private image processor stopped unexpectedly."));
    }
    for (const preparation of this.preparations.values()) {
      preparation.reject(new Error("The private image processor stopped unexpectedly."));
    }
    this.pending.clear();
    this.preparations.clear();
  };
}
