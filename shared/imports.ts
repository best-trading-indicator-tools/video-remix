import type { VideoSource } from "./types.js";
import type { Diagnostic } from "./diagnostics.js";

export const DEFAULT_IMPORT_BATCH_SIZE = 100;

/** Upload bytes and media processing are separate, resumable stages. */
export interface ImportSession {
  id: string;
  name: string;
  size: number;
  offset: number;
  chunkSize: number;
  kind: "upload" | "local" | "remote";
  status: "uploading" | "processing" | "completed" | "failed";
  phase: string;
  progress: number;
  /** Orders status transitions, including restarting a failed link import. */
  updatedAt?: number;
  identity?: string;
  lastModified?: number;
  source?: VideoSource;
  error?: string;
  diagnostic?: Diagnostic;
  /** Standalone downloads share the queue, but never enter the editing workspace. */
  purpose?: "download";
  remoteUrl?: string;
  stripMetadata?: boolean;
  download?: {
    url: string;
    thumbnailUrl: string;
    duration: number;
    width: number;
    height: number;
    size: number;
    expiresAt: string;
  };
}
