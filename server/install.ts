// Where Downstream's own files live. A clone runs the TypeScript sources in
// place; a published copy (npx, npm install) sits under node_modules, where
// Node won't strip types, so it runs the JavaScript compiled into dist/.
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Install = "clone" | "published";

const compiledExtension = ".js";
export const install: Install = import.meta.url.endsWith(compiledExtension) ? "published" : "clone";

/** Holds package.json, SKILL.md, bin/ and web/dist/. */
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), install === "published" ? "../.." : "..");

/** Holds cli/, server/ and domain/ in the form Node runs. */
export const codeRoot = install === "published" ? path.join(packageRoot, "dist") : packageRoot;

export const serverEntry = path.join(codeRoot, "server", install === "published" ? "main.js" : "main.ts");
