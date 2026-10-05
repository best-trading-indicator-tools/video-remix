import { json, Router, type ErrorRequestHandler, type Express } from "express";
import { z } from "zod";
import { API_PROVIDERS } from "../shared/api-keys.js";
import { apiKeys, apiKeySchema, type ApiKeyStore } from "./api-keys.js";

export function installApiKeyRoutes(app: Express, store: ApiKeyStore = apiKeys) {
  const router = Router();
  router.use((req, res, next) => {
    // The app's existing host guard applies to this private installation.
    // Reject cross-origin writes, including pages on a different localhost port.
    const origin = req.get("origin");
    if (origin && origin !== `${req.protocol}://${req.get("host")}`)
      return res.status(403).json({ error: "Open Settings in the local app to manage API keys." });
    if (req.method !== "GET" && req.get("x-remix-settings") !== "1")
      return res.status(403).json({ error: "Open Settings to manage API keys." });
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use(json({ limit: "8kb" }));
  router.get("/", (_req, res) => res.json(store.status()));
  const providerSchema = z.enum(API_PROVIDERS);
  const bodySchema = z.object({ apiKey: apiKeySchema }).strict();
  router.put("/:provider", async (req, res) => {
    const provider = providerSchema.safeParse(req.params.provider);
    const body = bodySchema.safeParse(req.body);
    if (!provider.success || !body.success)
      return res.status(400).json({ error: "Enter a valid API key without spaces or line breaks." });
    try { await store.update(provider.data, body.data.apiKey); }
    catch { return res.status(500).json({ error: "Could not save the API key. Check server storage and try again." }); }
    res.json(store.status());
  });
  router.delete("/:provider", async (req, res) => {
    const provider = providerSchema.safeParse(req.params.provider);
    if (!provider.success) return res.status(400).json({ error: "Unknown API provider." });
    try { await store.update(provider.data, null); }
    catch { return res.status(500).json({ error: "Could not remove the saved API key. Try again." }); }
    res.json(store.status());
  });
  // JSON parser errors may include submitted text; never echo credential input.
  const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(error.status === 413 ? 413 : 400).json({ error: "Could not read the API key. Enter a valid key and try again." });
  };
  router.use(handleError);
  app.use("/api/settings/api-keys", router);
}
