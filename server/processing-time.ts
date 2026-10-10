import os from "node:os";
import { config } from "./config.js";
// Measurements belong to this engine and its configured worker count.
export const timingMachine = JSON.stringify([os.platform(), os.arch(), os.cpus()[0]?.model, os.cpus().length, Math.round(os.totalmem() / 2 ** 30), config.concurrency]);
