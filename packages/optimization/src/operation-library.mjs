/** Lossless JSON whitespace reduction: preserve number lexemes, duplicate keys and string escapes. */
export function compactJsonOutput(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > 1_048_576 || !/^\s*[\[{]/.test(source)) return null;
  try { JSON.parse(source); } catch { return null; }
  let quoted = false, escaped = false, compact = "";
  for (const ch of source) {
    if (quoted) {
      compact += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') { quoted = true; compact += ch; }
    else if (!/[ \t\r\n]/.test(ch)) compact += ch;
  }
  if (source.endsWith("\n")) compact += "\n";
  return Buffer.byteLength(compact) < Buffer.byteLength(source) ? compact : null;
}
export function outputFormat(source) {
  if (typeof source !== "string") return "none";
  if (/^TAP version 13(?:\r?\n|$)/.test(source)) return "node-tap";
  if (/^\s*[\[{]/.test(source) && Buffer.byteLength(source) <= 1_048_576) {
    try { JSON.parse(source); return "json"; } catch { return "incomplete-json"; }
  }
  return "text";
}
