import type { DetectionReport } from "./detector";

export type ExecutionProvider = "webgpu" | "wasm";

export interface ProcessingReport extends DetectionReport {
  canonicalDimensions: [number, number];
  changedPixels: number;
  changedPixelsOutsideMask: 0;
  timestampSequenceRedetected: false;
  outsideMaskRgbExact: true;
  editedAreaPercent: number;
  inputSha256: string;
  outputSha256: string;
  modelSha256: string;
  modelRevision: string;
  executionProvider: ExecutionProvider;
  outputFormat: "lossless PNG RGB, orientation normalized";
}

export interface ProcessedImage {
  blob: Blob;
  outputName: string;
  report: ProcessingReport;
}

export type WorkerRequest =
  | { type: "process"; id: string; file: File; preferWebGpu: boolean }
  | { type: "clear-model-cache" };

export type ProcessingStage =
  | "decode"
  | "detect"
  | "model-download"
  | "reconstruct"
  | "verify"
  | "encode";

export type WorkerResponse =
  | {
      type: "progress";
      id: string;
      stage: ProcessingStage;
      progress?: number;
      detail?: string;
    }
  | { type: "result"; id: string; result: ProcessedImage }
  | { type: "error"; id: string; message: string; code: string };
