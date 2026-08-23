import type { ProcessedImage, WorkerResponse } from "./processing-types";

interface PendingRequest {
  resolve: (result: ProcessedImage) => void;
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

  terminate(reason = "Processing was canceled."): void {
    this.closed = true;
    this.worker.terminate();
    for (const request of this.pending.values()) request.reject(new Error(reason));
    this.pending.clear();
  }

  private handleMessage = (event: MessageEvent<WorkerResponse>): void => {
    const message = event.data;
    const request = this.pending.get(message.id);
    if (!request) return;
    if (message.type === "progress") {
      request.onProgress(message);
      return;
    }
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
    this.pending.clear();
  };
}
