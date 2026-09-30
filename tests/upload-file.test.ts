import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openRegularUpload, UnsafeUploadError } from "../server/upload-file.js";

test("upload guards work without O_NOFOLLOW and never modify a substituted original", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "upload-file-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const original = path.join(directory, "original.mp4");
  const upload = path.join(directory, "upload.mp4");
  await fs.writeFile(original, "precious original video");
  await fs.writeFile(upload, "uploaded bytes");
  const handle = await openRegularUpload(upload, "win32");
  await handle.write(Buffer.from("more"), 0, 4, 14);
  await handle.close();
  assert.equal(await fs.readFile(upload, "utf8"), "uploaded bytesmore");

  await fs.rm(upload);
  await fs.symlink(original, upload);
  await assert.rejects(openRegularUpload(upload, "win32"), UnsafeUploadError);
  await fs.rm(upload);
  await fs.writeFile(upload, "new upload");

  const originalOpen = fs.open;
  const mockedOpen = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === upload) {
      // Simulate replacement after lstat but before the handle opens.
      await fs.rm(upload);
      await fs.symlink(original, upload);
    }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mockedOpen.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(openRegularUpload(upload, "win32"), UnsafeUploadError);
  assert.equal(await fs.readFile(original, "utf8"), "precious original video");
});
