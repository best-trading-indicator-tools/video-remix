import assert from "node:assert/strict";
import { test } from "node:test";
import { runLocal } from "../server/auto-process.js";

test("cancelling a model worker kills descendants even when they ignore SIGTERM", { skip: process.platform === "win32", timeout: 10_000 }, async () => {
  const controller = new AbortController();
  let descendant = 0;
  const childCode = "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)";
  const parentCode = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','pipe','ignore']});c.stdout.once('data',()=>console.log(c.pid));setInterval(()=>{},1000)`;
  const alive = () => { try { process.kill(descendant, 0); return true; } catch { return false; } };
  try {
    await assert.rejects(runLocal(process.execPath, ["-e", parentCode], { processGroup: true, signal: controller.signal,
      onStdout: chunk => { descendant = Number(chunk.trim()); if (descendant > 0) controller.abort(); } }), { name: "AbortError" });
    assert.ok(descendant > 0);
    const deadline = Date.now() + 2000;
    while (alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(alive(), false, "No orphan decoder or encoder may keep running after cancellation");
  } finally { if (descendant > 0 && alive()) process.kill(descendant, "SIGKILL"); }
});
