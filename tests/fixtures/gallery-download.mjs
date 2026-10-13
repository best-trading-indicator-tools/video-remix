import { access, copyFile, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2), url = args.at(-1);
if (!args.includes("--config-ignore") || args.includes("--no-postprocessors") || !args.includes("--Print") || !args.includes("{num:03}.{extension}")) process.exit(9);
const cookies = args.indexOf("--cookies");
if (cookies >= 0) {
  await writeFile("cookie-input.txt", await readFile(args[cookies + 1]));
  await writeFile(args[cookies + 1], "# Netscape HTTP Cookie File\n# changed by extractor\n");
}
if (url.includes("Private")) { console.error("Login required"); process.exit(1); }
if (url.includes("Empty")) process.exit(0);
if (url.includes("Retry")) {
  const marker = path.join(process.env.REMIX_TEST_CAROUSEL_DIR, "retry-marker");
  try { await access(marker); } catch { await writeFile(marker, "1"); console.error("HTTP 429"); process.exit(1); }
}
if (url.includes("Slow")) {
  await writeFile("001.jpg.part", "partial");
  console.log("remix-image:001.jpg");
  await new Promise(resolve => setTimeout(resolve, 5000));
} else console.log("remix-image:001.jpg");
if (url.includes("Many")) { for (let i = 2; i <= 101; i++) console.log(`remix-image:${String(i).padStart(3, "0")}.jpg`); process.exit(0); }
if (url.includes("Duplicate")) { console.log("remix-image:001.jpg"); process.exit(0); }
if (url.includes("Unsafe")) { console.log("remix-image:../private.jpg"); process.exit(0); }
for (const name of ["001.jpg", "003.jpg", "010.jpg"]) {
  if (name !== "001.jpg") console.log(`remix-image:${name}`);
  if (url.includes("Missing") && name === "003.jpg") continue;
  if (url.includes("Symlink")) await symlink(process.env.REMIX_TEST_CAROUSEL_IMAGE, name);
  else if (url.includes("Invalid")) await writeFile(name, "not an image");
  else await copyFile(process.env.REMIX_TEST_CAROUSEL_IMAGE, name);
}
