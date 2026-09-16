import type { VideoSource } from "./types.js";

export const DEFAULT_IMPORT_BATCH_SIZE = 100;

/** Upload bytes and media processing are separate, resumable stages. */
export interface ImportSession {
  id: string;
  name: string;
  size: number;
  offset: number;
  chunkSize: number;
  kind: "upload" | "local";
  status: "uploading" | "processing" | "completed" | "failed";
  phase: string;
  progress: number;
  identity?: string;
  lastModified?: number;
  source?: VideoSource;
  error?: string;
}
