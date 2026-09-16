import { bundle } from "@remotion/bundler";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.resolve(
  process.argv[2] || path.join(root, "dist-remotion"),
);
// Only this repository's authored entry point is accepted. Public project
// files and environment variables must never be copied into the bundle.
await mkdir(output, { recursive: true });
try {
  await bundle({
    entryPoint: path.join(root, "remotion/index.tsx"),
    rootDir: root,
    outDir: output,
    publicDir: path.join(root, "remotion/public"),
    enableCaching: false,
    gitSource: null,
    webpackOverride: (configuration) => ({ ...configuration, devtool: false,
      // Shared scene code uses Node ESM .js specifiers; resolve its TS source in the browser bundle.
      resolve: { ...configuration.resolve, extensionAlias: { ...configuration.resolve?.extensionAlias, ".js": [".ts", ".tsx", ".js"] } },
    }),
  });
} catch (error) {
  await rm(output, { recursive: true, force: true });
  throw error;
}
