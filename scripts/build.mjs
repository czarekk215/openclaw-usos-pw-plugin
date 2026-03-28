import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const src = path.join(root, "src", "index.js");
const distDir = path.join(root, "dist");
const dist = path.join(distDir, "index.js");

await mkdir(distDir, { recursive: true });
await copyFile(src, dist);
console.log(`Built ${dist}`);
