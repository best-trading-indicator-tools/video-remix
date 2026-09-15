import path from "node:path";
const numberEnv = (key: string, fallback: number, min: number, max: number) => {
  const value =
    process.env[key] === undefined ? fallback : Number(process.env[key]);
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`${key} must be between ${min} and ${max}.`);
  return Math.floor(value);
};
export const config = {
  port: numberEnv("PORT", 8787, 1, 65535),
  host: process.env.HOST || "127.0.0.1",
  dataDir: path.resolve(process.env.DATA_DIR || "data"),
  maxFileSize: numberEnv("MAX_FILE_SIZE_MB", 500, 1, 2048) * 1024 * 1024,
  maxFiles: numberEnv("MAX_FILES", 30, 1, 100),
  concurrency: numberEnv("RENDER_CONCURRENCY", 2, 1, 4),
  retentionMs: numberEnv("RETENTION_HOURS", 24, 1, 720) * 3600000,
};
export const paths = {
  uploads: path.join(config.dataDir, "uploads"),
  thumbnails: path.join(config.dataDir, "thumbnails"),
  attachments: path.join(config.dataDir, "attachments"),
  outputs: path.join(config.dataDir, "outputs"),
  work: path.join(config.dataDir, "work"),
};
