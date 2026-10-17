import { execFileSync, execSync } from "node:child_process";

function validLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Output byte limit must be a nonnegative safe integer");
}

const codePageEncodings: Record<string, string> = {
  "866": "ibm866",
  "1250": "windows-1250",
  "1251": "windows-1251",
  "1252": "windows-1252",
  "1253": "windows-1253",
  "1254": "windows-1254",
  "1255": "windows-1255",
  "1256": "windows-1256",
  "1257": "windows-1257",
  "1258": "windows-1258",
  "874": "windows-874",
  "932": "shift_jis",
  "936": "gbk",
  "949": "euc-kr",
  "950": "big5",
  "65001": "utf-8"
};

let cachedOemEncoding: string | null | undefined = undefined;
let cachedAnsiEncoding: string | null | undefined = undefined;

export function getWindowsOemEncoding(): string | null {
  if (cachedOemEncoding !== undefined) return cachedOemEncoding;
  if (process.env.LCMCP_CONSOLE_ENCODING) {
    return (cachedOemEncoding = process.env.LCMCP_CONSOLE_ENCODING);
  }
  if (process.platform !== "win32") return (cachedOemEncoding = null);
  try {
    // Commands run hidden, in a console of their own. Probe one the same way:
    // the agent's own console can use another code page (65001 in a UTF-8 terminal).
    const out = execSync("chcp.com", { stdio: ["ignore", "pipe", "ignore"], encoding: "ascii", windowsHide: true });
    const cp = out.match(/\d+/)?.[0];
    return (cachedOemEncoding = (cp && codePageEncodings[cp]) || null);
  } catch {
    return (cachedOemEncoding = null);
  }
}

export function setWindowsOemEncodingForTest(encoding: string | null | undefined): void {
  cachedOemEncoding = encoding;
}

// The system ANSI code page. An explicit LCMCP_CONSOLE_ENCODING is the only fallback.
export function getWindowsAnsiEncoding(): string | null {
  if (cachedAnsiEncoding !== undefined) return cachedAnsiEncoding;
  if (process.env.LCMCP_CONSOLE_ENCODING || process.platform !== "win32") return (cachedAnsiEncoding = null);
  try {
    const reg = `${process.env.SystemRoot || "C:\\Windows"}\\System32\\reg.exe`;
    const out = execFileSync(reg, ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage", "/v", "ACP"], { stdio: ["ignore", "pipe", "ignore"], encoding: "ascii", windowsHide: true, timeout: 5_000 });
    const cp = out.match(/\bACP\s+REG_SZ\s+(\d+)/)?.[1];
    return (cachedAnsiEncoding = (cp && codePageEncodings[cp]) || null);
  } catch {
    return (cachedAnsiEncoding = null);
  }
}

interface StreamDecoder {
  write(chunk: Buffer): string;
  end(): string;
}

function decoderFor(encoding: string | null | undefined): TextDecoder | null {
  if (!encoding || encoding === "utf-8") return null;
  try { return new TextDecoder(encoding); } catch { return null; }
}

// Letters count for a decoding; symbols, control characters and an uppercase
// letter right after a lowercase one count against it. Misread Cyrillic turns
// into box drawing and mixed-case words. ASCII decodes the same either way.
function textScore(text: string): number {
  let score = 0, afterLower = false;
  for (const char of text) {
    let lower = false;
    if (char < "\x80") lower = char >= "a" && char <= "z";
    else if (/\p{Ll}/u.test(char)) { score++; lower = true; }
    else if (/\p{Lu}/u.test(char)) score += afterLower ? -1 : 1;
    else if (/\p{L}/u.test(char)) score++;
    else if (/[\p{S}\p{C}]/u.test(char)) score--;
    afterLower = lower;
  }
  return score;
}

// Some programs write the ANSI code page to a pipe instead of the console's OEM
// one: chcp itself, and Python or Java with default settings. Decide once per
// stream, from the first non-UTF-8 bytes; a tie keeps OEM. An explicit encoding
// is used as given.
function chooseFallbackDecoder(explicit: string | null | undefined, evidence: Buffer): TextDecoder | null {
  if (explicit !== undefined) return decoderFor(explicit);
  const oem = decoderFor(getWindowsOemEncoding());
  if (!oem) return null;
  const ansi = decoderFor(getWindowsAnsiEncoding());
  if (!ansi || ansi.encoding === oem.encoding) return oem;
  const start = Math.max(0, evidence.findIndex(byte => byte >= 0x80));
  const sample = evidence.subarray(start, start + 4_096);
  return textScore(ansi.decode(sample)) > textScore(oem.decode(sample)) ? ansi : oem;
}

// Length of an unfinished code point at the end of valid UTF-8 input.
function unfinishedTail(bytes: Buffer): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const size = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return size > back ? back : 0;
  }
  return 0;
}

function createAdaptiveDecoder(fallbackEncoding?: string | null): StreamDecoder {
  let isUtf8 = true;
  let utf8Decoder = new TextDecoder("utf-8", { fatal: true });
  let fallbackDecoder: TextDecoder | null = null;
  let pendingLead = Buffer.alloc(0);

  return {
    write(chunk: Buffer): string {
      if (chunk.length === 0) return "";
      if (isUtf8) {
        try {
          const text = utf8Decoder.decode(chunk, { stream: true });
          // Keep the bytes of an unfinished code point: if the stream turns
          // out not to be UTF-8, they belong to the fallback decoding.
          if (text.length > 0) {
            pendingLead = Buffer.from(chunk.subarray(chunk.length - unfinishedTail(chunk)));
          } else {
            pendingLead = Buffer.concat([pendingLead, chunk]);
          }
          return text;
        } catch {
          isUtf8 = false;
          if (pendingLead.length > 0) {
            chunk = Buffer.concat([pendingLead, chunk]);
            pendingLead = Buffer.alloc(0);
          }
          fallbackDecoder = chooseFallbackDecoder(fallbackEncoding, chunk);
        }
      }
      if (fallbackDecoder) {
        return fallbackDecoder.decode(chunk, { stream: true });
      }
      return new TextDecoder("utf-8").decode(chunk);
    },
    end(): string {
      if (isUtf8) {
        try {
          const text = utf8Decoder.decode();
          pendingLead = Buffer.alloc(0);
          return text;
        } catch {
          isUtf8 = false;
          fallbackDecoder = chooseFallbackDecoder(fallbackEncoding, pendingLead);
          if (pendingLead.length > 0 && fallbackDecoder) {
            const flushed = fallbackDecoder.decode(pendingLead);
            pendingLead = Buffer.alloc(0);
            return flushed;
          }
        }
      }
      if (fallbackDecoder) {
        return fallbackDecoder.decode();
      }
      return "";
    }
  };
}

// Input is valid UTF-8. Retain complete code points only, and copy the retained
// bytes so a small tail never pins a much larger backing buffer in memory.
function suffixStart(bytes: Buffer, limit: number): number {
  let start = Math.max(0, bytes.length - limit);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return start;
}

export class ByteBoundedTextTail {
  private bytes: Buffer = Buffer.alloc(0);
  truncated = false;

  constructor(private readonly maxBytes: number) { validLimit(maxBytes); }

  appendText(text: string): void {
    if (!text) return;
    if (this.maxBytes === 0) { this.truncated = true; return; }
    // UTF-8 needs at least as many bytes as UTF-16 code units. Avoid encoding
    // an arbitrarily large incoming string when only a bounded suffix can fit.
    let suffix = text;
    if (suffix.length > this.maxBytes) {
      let start = suffix.length - this.maxBytes;
      if (start > 0 && /[\uDC00-\uDFFF]/.test(suffix[start]!) && /[\uD800-\uDBFF]/.test(suffix[start - 1]!)) start++;
      suffix = suffix.slice(start);
      this.bytes = Buffer.alloc(0); // Earlier output precedes a discarded part of this chunk.
      this.truncated = true;
    }
    const incoming = Buffer.from(suffix, "utf8");
    if (incoming.length >= this.maxBytes) {
      const start = suffixStart(incoming, this.maxBytes);
      this.truncated ||= this.bytes.length > 0 || start > 0;
      this.bytes = Buffer.from(incoming.subarray(start));
      return;
    }
    const remaining = this.maxBytes - incoming.length;
    const start = suffixStart(this.bytes, remaining);
    this.truncated ||= start > 0;
    this.bytes = Buffer.concat([this.bytes.subarray(start), incoming]);
  }

  toString(): string { return this.bytes.toString("utf8"); }
}

export class Utf8OutputTailBuffer {
  private readonly decoder: StreamDecoder;
  private readonly tail: ByteBoundedTextTail;
  private ended = false;

  constructor(maxBytes: number, encoding?: string | null) {
    this.tail = new ByteBoundedTextTail(maxBytes);
    this.decoder = createAdaptiveDecoder(encoding);
  }

  append(chunk: Buffer | string): void {
    if (this.ended) return;
    // A string chunk is UTF-8 data too; using the same decoder preserves the
    // ordering of any pending bytes from a preceding Buffer chunk.
    if (typeof chunk === "string") {
      for (let offset = 0; offset < chunk.length;) {
        let end = Math.min(chunk.length, offset + 16_384);
        if (end < chunk.length && /[\uD800-\uDBFF]/.test(chunk[end - 1]!) && /[\uDC00-\uDFFF]/.test(chunk[end]!)) end++;
        this.tail.appendText(this.decoder.write(Buffer.from(chunk.slice(offset, end), "utf8")));
        offset = end;
      }
    } else {
      for (let offset = 0; offset < chunk.length; offset += 65_536) {
        this.tail.appendText(this.decoder.write(chunk.subarray(offset, offset + 65_536)));
      }
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.tail.appendText(this.decoder.end());
  }

  toString(): string { return this.tail.toString(); }
  get truncated(): boolean { return this.tail.truncated; }
}
