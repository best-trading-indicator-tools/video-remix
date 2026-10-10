import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
const { showBatchNotification } = createRequire(import.meta.url)("../desktop/notifications.cjs");
test("native notification click opens Exports; rejected unsigned builds fall back without failing the batch", async () => {
  let instance: MockNotification; const events: string[] = [];
  class MockNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(_: unknown) { super(); instance = this; }
    show() { this.emit("show"); }
  }
  const window = { isDestroyed: () => false, isMinimized: () => true, restore: () => events.push("restore"), show: () => {}, focus: () => events.push("focus"), flashFrame: (on: boolean) => events.push(`flash:${on}`), webContents: { send: (channel: string) => events.push(channel) } };
  const app = { dock: { bounce: () => events.push("bounce") } };
  assert.equal(await showBatchNotification({ Notification: MockNotification, window, app, body: "12 ready" }), true);
  instance!.emit("click"); assert.ok(events.includes("batches:open")); assert.ok(events.includes("focus"));
  MockNotification.prototype.show = function() { this.emit("failed", {}, "Unsigned"); };
  assert.equal(await showBatchNotification({ Notification: MockNotification, window, app, body: "1 ready · 1 failed" }), false);
  assert.ok(events.includes("bounce"));
  assert.throws(() => showBatchNotification({ Notification: MockNotification, window, app, body: "x".repeat(201) }));
});
