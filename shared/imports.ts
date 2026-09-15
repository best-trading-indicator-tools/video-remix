import type { VideoSource } from "./types.js";

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
