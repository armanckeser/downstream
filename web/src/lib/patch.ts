// Symbol frames arrive as one-hunk patches numbered like the real file.
// Earlier frames on a trail collapse to a window around the call that led on.

export type Row = { type: " " | "+" | "-"; oldNo: number | null; newNo: number | null; text: string };
export type ParsedFrame = { header: string[]; rows: Row[] };

export function parseFrame(patch: string): ParsedFrame {
  const lines = patch.split("\n");
  const at = lines.findIndex((l) => l.startsWith("@@"));
  const m = lines[at]!.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)!;
  let oldNo = Number(m[1]);
  let newNo = Number(m[2]);
  const rows: Row[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l === "" || l.startsWith("\\")) continue;
    const type = l[0] as Row["type"];
    if (type === "+") rows.push({ type, oldNo: null, newNo: newNo++, text: l.slice(1) });
    else if (type === "-") rows.push({ type, oldNo: oldNo++, newNo: null, text: l.slice(1) });
    else rows.push({ type: " ", oldNo: oldNo++, newNo: newNo++, text: l.slice(1) });
  }
  return { header: lines.slice(0, at), rows };
}

export function buildPatch(frame: ParsedFrame, rows: Row[]): string {
  if (!rows.length) return "";
  const firstOld = rows.find((r) => r.oldNo !== null)?.oldNo ?? 0;
  const firstNew = rows.find((r) => r.newNo !== null)?.newNo ?? 0;
  const oldCount = rows.filter((r) => r.type !== "+").length;
  const newCount = rows.filter((r) => r.type !== "-").length;
  const body = rows.map((r) => r.type + r.text);
  return [...frame.header, `@@ -${oldCount ? firstOld : 0},${oldCount} +${newCount ? firstNew : 0},${newCount} @@`, ...body].join("\n") + "\n";
}

/** Rows around a line on the new side (or old side for removed code). */
export function windowAround(frame: ParsedFrame, line: number, side: "new" | "old", radius = 2): Row[] {
  const i = frame.rows.findIndex((r) => (side === "new" ? r.newNo : r.oldNo) === line);
  if (i < 0) return frame.rows.slice(0, radius * 2 + 1);
  return frame.rows.slice(Math.max(0, i - radius), i + radius + 1);
}

export const languageOf = (file: string) => file.split(".").pop() ?? "";

/** Several windows of one frame as a multi-hunk patch; Pierre draws a separator between them. */
export function buildHunks(frame: ParsedFrame, groups: Row[][]): string {
  const body: string[] = [];
  for (const rows of groups) {
    if (!rows.length) continue;
    const firstOld = rows.find((r) => r.oldNo !== null)?.oldNo ?? 0;
    const firstNew = rows.find((r) => r.newNo !== null)?.newNo ?? 0;
    const oldCount = rows.filter((r) => r.type !== "+").length;
    const newCount = rows.filter((r) => r.type !== "-").length;
    body.push(`@@ -${oldCount ? firstOld : 0},${oldCount} +${newCount ? firstNew : 0},${newCount} @@`, ...rows.map((r) => r.type + r.text));
  }
  return [...frame.header, ...body].join("\n") + "\n";
}

/** Keep what a reviewer needs from a long symbol: its signature, every change, and the lines people pointed at. */
export function foldFrame(frame: ParsedFrame, keepNew: Set<number>, radius = 3): { patch: string; hidden: number } {
  const rows = frame.rows;
  const keep = new Array<boolean>(rows.length).fill(false);
  const mark = (i: number) => {
    for (let j = Math.max(0, i - radius); j <= Math.min(rows.length - 1, i + radius); j++) keep[j] = true;
  };
  rows.forEach((r, i) => {
    if (i < 2 || r.type !== " " || (r.newNo !== null && keepNew.has(r.newNo))) mark(i);
  });
  keep[rows.length - 1] = true;
  const groups: Row[][] = [];
  let cur: Row[] = [];
  rows.forEach((r, i) => {
    if (keep[i]) cur.push(r);
    else if (cur.length) {
      groups.push(cur);
      cur = [];
    }
  });
  if (cur.length) groups.push(cur);
  return { patch: buildHunks(frame, groups), hidden: keep.filter((k) => !k).length };
}
