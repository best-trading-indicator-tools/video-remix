import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findStockBroll } from "../server/stock-broll.js";

const hit = (id = 7, link = `https://videos.pexels.com/video-files/${id}/ocean.mp4`) => ({
  id, url: `https://www.pexels.com/video/ocean-waves-${id}/`, duration: 8, user: { name: "Test artist" },
  video_files: [{ file_type: "video/mp4", width: 1280, height: 720, link }],
});
test("Pexels supports safe existing video search, isolated auth, credits and cached responses", async () => {
  const old = process.env.PEXELS_API_KEY; process.env.PEXELS_API_KEY = "private-pexels-test-key";
  const directory = await mkdtemp(path.join(tmpdir(), "pexels-test-"));
  let searches = 0, downloads = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.redirect, "error");
    if (url.hostname === "api.pexels.com") {
      searches++;
      assert.equal(url.pathname, "/v1/videos/search");
      assert.ok(url.searchParams.get("query")?.includes("ocean"));
      assert.equal(new Headers(init?.headers).get("Authorization"), "private-pexels-test-key");
      assert.ok(!url.href.includes("private-pexels"));
      return Response.json({ videos: [hit(), hit(8, "https://127.0.0.1/private.mp4"), hit(9, "https://videos.pexels.com.attacker.test/video-files/a.mp4")] });
    }
    assert.equal(url.hostname, "videos.pexels.com");
    assert.equal(new Headers(init?.headers).get("Authorization"), null);
    downloads++;
    return new Response(new Uint8Array([1, 2, 3, 4]));
  };
  const options = { moments: [{ text: "ocean waves" }], providers: ["pexels" as const], workDir: directory,
    cacheDir: path.join(directory, "cache"), signal: new AbortController().signal, onPhase: () => {}, fetcher,
    probe: async () => ({ duration: 8, width: 1280, height: 720, fps: 24, hasAudio: false }),
    inspect: async () => [{ sourceStart: 0, duration: 3, motion: 0.8, cropRetention: 0.5, score: 1 }] };
  try {
    const result = await findStockBroll(options);
    assert.equal(result.assets.length, 1);
    assert.equal(result.assets[0]!.stock?.providerId, "pexels:7");
    assert.equal(result.assets[0]!.attribution?.creator, "Test artist");
    assert.equal(result.assets[0]!.attribution?.provider, "Pexels");
    assert.equal(result.assets[0]!.stock?.licenseUrl, "https://www.pexels.com/license/");
    assert.equal(result.assets[0]!.size, 4);
    await findStockBroll(options);
    assert.equal(searches, 1); assert.equal(downloads, 2);
    for (const file of await readdir(options.cacheDir)) assert.ok(!(await readFile(path.join(options.cacheDir, file), "utf8")).includes("private-pexels-test-key"));
    const animation = await findStockBroll({ ...options, type: "animation" });
    assert.equal(animation.assets.length, 0); assert.match(animation.notes.join(" "), /animation-only/);
    assert.equal(searches, 1);
  } finally { if (old === undefined) delete process.env.PEXELS_API_KEY; else process.env.PEXELS_API_KEY = old; await rm(directory, { recursive: true, force: true }); }
});

test("a failed Pixabay search does not prevent the selected Pexels provider from finding footage", async () => {
  const old = [process.env.PEXELS_API_KEY, process.env.PIXABAY_API_KEY];
  process.env.PEXELS_API_KEY = "test-pexels"; process.env.PIXABAY_API_KEY = "test-pixabay";
  const directory = await mkdtemp(path.join(tmpdir(), "stock-failover-"));
  try {
    const result = await findStockBroll({ moments: [{ text: "ocean waves" }], providers: ["pixabay", "pexels"],
      workDir: directory, cacheDir: directory, signal: new AbortController().signal, onPhase: () => {},
      fetcher: async input => String(input).startsWith("https://pixabay.com/") ? new Response("", {status: 429}) :
        String(input).startsWith("https://api.pexels.com/") ? Response.json({ videos: [hit()] }) : new Response(new Uint8Array([1])),
      probe: async () => ({ duration: 8, width: 1280, height: 720, fps: 24, hasAudio: false }),
      inspect: async () => [{ sourceStart: 0, duration: 3, motion: 0.8, cropRetention: 0.5, score: 1 }],
    });
    assert.equal(result.assets[0]?.attribution?.provider, "Pexels");
    assert.match(result.notes.join(" "), /Pixabay search was unavailable/);
  } finally { for (const [i, key] of ["PEXELS_API_KEY", "PIXABAY_API_KEY"].entries()) { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; } await rm(directory, {recursive: true, force:true}); }
});
