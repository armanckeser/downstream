// A small fictional repository for the README film: a storefront whose pull
// request adds discount codes at checkout. Nothing in it is real, so the film
// can be shot again anywhere.
// node scripts/film/storefront.mjs <dir>
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const [dir] = process.argv.slice(2);
if (!dir) throw new Error("usage: node scripts/film/storefront.mjs <dir>");

const BASE = {
  "package.json": `{ "name": "storefront", "private": true, "type": "module" }\n`,
  "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true
  },
  "include": ["src"]
}
`,
  "src/pricing/types.ts": `export type Line = { sku: string; unitCents: number; quantity: number };

export type Cart = { lines: Line[] };

/** Everything the receipt shows, in cents. */
export type Total = { subtotal: number; tax: number; cents: number };
`,
  "src/pricing/price-cart.ts": `import type { Cart, Total } from "./types.ts";

const TAX_RATE = 0.08;

/** What the customer pays for a cart, tax included. */
export function priceCart(cart: Cart): Total {
  const subtotal = cart.lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0);
  const tax = Math.round(subtotal * TAX_RATE);
  return { subtotal, tax, cents: subtotal + tax };
}
`,
  "src/routes/checkout.ts": `import { priceCart } from "../pricing/price-cart.ts";
import type { Cart } from "../pricing/types.ts";

type Charge = (cents: number) => Promise<string>;

/** POST /checkout: prices the cart and charges the customer's card. */
export async function postCheckout(body: { cart: Cart }, charge: Charge) {
  const total = priceCart(body.cart);
  const receipt = await charge(total.cents);
  return { receipt, total };
}
`,
};

const HEAD = {
  "src/pricing/types.ts": `export type Line = { sku: string; unitCents: number; quantity: number };

export type Cart = { lines: Line[] };

/** Everything the receipt shows, in cents. */
export type Total = { subtotal: number; discount: number; tax: number; cents: number };

/** A code takes either a share of the subtotal or a fixed amount off it. */
export type DiscountCode =
  | { code: string; kind: "percent"; percent: number; expires: Date }
  | { code: string; kind: "fixed"; amountCents: number; expires: Date };
`,
  "src/pricing/codes.ts": `import type { DiscountCode } from "./types.ts";

export const CODES: DiscountCode[] = [
  { code: "WELCOME10", kind: "percent", percent: 10, expires: new Date("2027-01-01") },
  { code: "SPRING20", kind: "fixed", amountCents: 2000, expires: new Date("2027-06-01") },
];
`,
  "src/pricing/discount.ts": `import { CODES } from "./codes.ts";
import type { DiscountCode } from "./types.ts";

export class UnknownCode extends Error {}

/** Looks a code up the way customers type it, and turns away expired ones. */
export function findCode(typed: string, today = new Date()): DiscountCode {
  const code = CODES.find((c) => c.code === typed.trim().toUpperCase());
  if (!code || code.expires < today) throw new UnknownCode(typed);
  return code;
}

/** How many cents a code takes off a subtotal. */
export function applyDiscount(subtotal: number, code: DiscountCode): number {
  if (code.kind === "percent") return Math.round((subtotal * code.percent) / 100);
  return code.amountCents;
}
`,
  "src/pricing/price-cart.ts": `import { applyDiscount, findCode } from "./discount.ts";
import type { Cart, Total } from "./types.ts";

const TAX_RATE = 0.08;

/** What the customer pays for a cart, tax included, after any discount code. */
export function priceCart(cart: Cart, code?: string): Total {
  const subtotal = cart.lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0);
  const discount = code ? applyDiscount(subtotal, findCode(code)) : 0;
  const taxable = subtotal - discount;
  const tax = Math.round(taxable * TAX_RATE);
  return { subtotal, discount, tax, cents: taxable + tax };
}
`,
  "src/routes/checkout.ts": `import { priceCart } from "../pricing/price-cart.ts";
import type { Cart } from "../pricing/types.ts";

type Charge = (cents: number) => Promise<string>;

/** POST /checkout: prices the cart and charges the customer's card. */
export async function postCheckout(body: { cart: Cart; code?: string }, charge: Charge) {
  const total = priceCart(body.cart, body.code);
  const receipt = await charge(total.cents);
  return { receipt, total };
}
`,
};

const git = (...args) =>
  execFileSync("git", ["-c", "user.name=Priya Shah", "-c", "user.email=priya@example.com", ...args], { cwd: dir, stdio: "ignore" });

function write(files) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
}

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
git("init", "-q", "-b", "main");
write(BASE);
git("add", ".");
git("commit", "-qm", "Price the cart at checkout");
git("checkout", "-qb", "discount-codes");
write(HEAD);
git("add", ".");
git("commit", "-qm", "Discount codes at checkout");
git("checkout", "-q", "main");

// An origin that looks like GitHub to Downstream (it reads .git/config) while
// git fetches from a bare copy beside it, with the PR's head where GitHub keeps it.
const origin = `${dir}.origin.git`;
const GITHUB_URL = "https://github.com/acme/storefront.git";
rmSync(origin, { recursive: true, force: true });
git("clone", "-q", "--bare", dir, origin);
execFileSync("git", ["-C", origin, "update-ref", "refs/pull/482/head", "discount-codes"]);
git("remote", "add", "origin", GITHUB_URL);
git("config", `url.${origin}.insteadOf`, GITHUB_URL);
git("fetch", "-q", "origin");
console.log(dir);
