import { copyFile } from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2);
if (!args.includes("--ignore-config") || !args.includes("--no-plugin-dirs") || !args.at(-1).startsWith("https://www.youtube.com/watch?v=")) process.exit(9);
await copyFile(path.join(process.env.REMIX_TEST_CAROUSEL_DIR, "fixture.mp4"), "video.mp4");
console.log('remix-result:{"file":"video.mp4","title":"YouTube media fixture"}');
