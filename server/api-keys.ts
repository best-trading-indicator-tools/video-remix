import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { API_PROVIDERS, type ApiProvider, type ApiKeySettings } from "../shared/api-keys.js";
import { config } from "./config.js";

const environmentNames: Record<ApiProvider, string> = {
  deepseek: "DEEPSEEK_API_KEY", pixabay: "PIXABAY_API_KEY",
  pexels: "PEXELS_API_KEY", postiz: "POSTIZ_API_KEY",
};
export const apiKeySchema = z.string().trim().min(1).max(4096).regex(/^[\x21-\x7e]+$/u);
const savedSchema = z.partialRecord(z.enum(API_PROVIDERS), apiKeySchema);
type SavedKeys = z.infer<typeof savedSchema>;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Private installation settings; environment credentials are never changed or copied. */
export class ApiKeyStore {
  private saved: SavedKeys = {};
  private ready = false;
  private hasVault = false;
  private writing: Promise<void> = Promise.resolve();
  private readonly directory: string;
  private readonly vault: string;
  private readonly keyFile: string;

  constructor(dataDir: string, private readonly environment: NodeJS.ProcessEnv = process.env) {
    this.directory = path.join(dataDir, "private");
    this.vault = path.join(this.directory, "api-keys.enc");
    this.keyFile = path.join(this.directory, "api-keys.key");
  }

  async initialize() {
    await this.writing;
    this.ready = false;
    let contents: Buffer;
    try { contents = await readFile(this.vault); }
    catch (error) {
      if (!missing(error)) throw new Error("Cannot read saved API keys. Check the private settings folder.");
      this.saved = {}; this.hasVault = false; this.ready = true; return;
    }
    try {
      const key = await this.encryptionKey(false);
      if (contents.length < 30 || contents[0] !== 1) throw new Error("Invalid vault");
      const decipher = createDecipheriv("aes-256-gcm", key, contents.subarray(1, 13));
      decipher.setAuthTag(contents.subarray(13, 29));
      this.saved = savedSchema.parse(JSON.parse(Buffer.concat([
        decipher.update(contents.subarray(29)), decipher.final(),
      ]).toString("utf8")));
      this.ready = true;
      this.hasVault = true;
    } catch {
      throw new Error("Cannot unlock saved API keys. Preserve both files in the private settings folder before repairing it.");
    }
  }

  get(provider: ApiProvider): string {
    return this.saved[provider] ?? this.environment[environmentNames[provider]]?.trim() ?? "";
  }

  status(): ApiKeySettings {
    return { providers: API_PROVIDERS.map(provider => ({
      provider,
      source: this.saved[provider] ? "settings" : this.get(provider) ? "environment" : "none",
      hasEnvironmentKey: Boolean(this.environment[environmentNames[provider]]?.trim()),
    })) };
  }

  /** Serialize updates so saving two providers at once cannot discard either key. */
  update(provider: ApiProvider, value: string | null): Promise<void> {
    const operation = this.writing.then(async () => {
      if (!this.ready) throw new Error("API key settings are not ready.");
      const next = { ...this.saved };
      if (value === null) delete next[provider];
      else next[provider] = apiKeySchema.parse(value);
      const key = await this.encryptionKey(!this.hasVault);
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(next), "utf8"), cipher.final()]);
      const temporary = `${this.vault}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted]));
          await file.sync();
        } finally { await file.close(); }
        await rename(temporary, this.vault);
        this.saved = next;
        this.hasVault = true;
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    this.writing = operation.catch(() => {});
    return operation;
  }

  private async encryptionKey(create: boolean): Promise<Buffer> {
    let key: Buffer;
    try { key = await readFile(this.keyFile); }
    catch (error) {
      if (!create || !missing(error)) throw error;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const generated = randomBytes(32);
      try {
        const file = await open(this.keyFile, "wx", 0o600);
        try { await file.writeFile(generated); await file.sync(); }
        finally { await file.close(); }
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
      }
      key = await readFile(this.keyFile);
    }
    if (key.length !== 32) throw new Error("Invalid settings encryption key.");
    return key;
  }
}

export const apiKeys = new ApiKeyStore(config.dataDir);
export const providerApiKey = (provider: ApiProvider) => apiKeys.get(provider);
