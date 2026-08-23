import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkerResponse } from "@/lib/processing-types";
import { ProcessorClient } from "@/lib/worker-client";

class FakeWorker {
  static latest: FakeWorker;

  readonly posted: unknown[] = [];
  terminated = false;
  private readonly messageHandlers: Array<(event: MessageEvent<WorkerResponse>) => void> = [];

  constructor() {
    FakeWorker.latest = this;
  }

  addEventListener(type: string, handler: (event: MessageEvent<WorkerResponse>) => void): void {
    if (type === "message") this.messageHandlers.push(handler);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: WorkerResponse): void {
    const event = { data: message } as MessageEvent<WorkerResponse>;
    for (const handler of this.messageHandlers) handler(event);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("model preparation client", () => {
  it("forwards progress and resolves with the selected provider", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const client = new ProcessorClient();
    const onProgress = vi.fn();
    const preparation = client.prepare("model-1", "mobile-safe", onProgress);

    expect(FakeWorker.latest.posted).toEqual([
      { type: "prepare-model", id: "model-1", profile: "mobile-safe" },
    ]);

    const progress: WorkerResponse = {
      type: "progress",
      id: "model-1",
      stage: "model-download",
      progress: 0.42,
    };
    FakeWorker.latest.emit(progress);
    expect(onProgress).toHaveBeenCalledWith(progress);

    FakeWorker.latest.emit({ type: "prepared", id: "model-1", provider: "wasm" });
    await expect(preparation).resolves.toBe("wasm");
  });

  it("cancels an in-flight preparation when the worker is terminated", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const client = new ProcessorClient();
    const preparation = client.prepare("model-2", "standard", vi.fn());

    client.terminate("Stopped");

    await expect(preparation).rejects.toThrow("Stopped");
    expect(FakeWorker.latest.terminated).toBe(true);
  });
});
