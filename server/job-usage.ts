import { withDeepSeekUsage } from "./deepseek-usage.js";
import { saveStore, type StoredJob } from "./store.js";

/** Append new charges on retries and rechecks; revisions start their own counters. */
export const withJobUsage = <T>(job: StoredJob, work: () => Promise<T>) => withDeepSeekUsage(job, work, () => saveStore());
