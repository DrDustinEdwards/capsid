// CSV for the Portal's exports (the claims export, design-portal-evaluation.md DECIDE 3).
// RFC 4180 quoting, and a cell that a spreadsheet would read as a formula (=, +, -, @,
// a tab or a carriage return first) is prefixed with an apostrophe, so an agent name or a
// namespace cannot run as one when the file is opened (OWASP, "CSV Injection").

export type Cell = string | number | null;

function cell(v: Cell): string {
  if (v === null) return "";
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly Cell[]>): string {
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** Hands the browser a file to save. */
export function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
