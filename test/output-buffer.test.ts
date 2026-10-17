import assert from "node:assert/strict";
import test from "node:test";
import { Utf8OutputTailBuffer, ByteBoundedTextTail } from "../src/output-buffer.js";

test("Utf8OutputTailBuffer decodes split UTF-8 characters", () => {
  const euro = Buffer.from("€", "utf8");
  const buffer = new Utf8OutputTailBuffer(10);
  buffer.append(euro.subarray(0, 1));
  assert.equal(buffer.toString(), "");
  buffer.append(euro.subarray(1));
  buffer.end();
  assert.equal(buffer.toString(), "€");
  assert.equal(buffer.truncated, false);
});

test("Utf8OutputTailBuffer keeps newest bytes after overflow", () => {
  const buffer = new Utf8OutputTailBuffer(5);
  buffer.append("abcdef");
  buffer.append("XYZ");
  buffer.end();
  assert.equal(buffer.toString(), "efXYZ");
  assert.equal(buffer.truncated, true);
});

test("Utf8OutputTailBuffer does not cut surrogate pairs", () => {
  const buffer = new Utf8OutputTailBuffer(4);
  buffer.append("a😀");
  buffer.end();
  assert.equal(buffer.toString(), "😀");
});

test("Utf8OutputTailBuffer handles caps smaller than a character", () => {
  const buffer = new Utf8OutputTailBuffer(1);
  buffer.append("€");
  buffer.end();
  assert.equal(buffer.toString(), "");
  assert.equal(buffer.truncated, true);
});

test("ByteBoundedTextTail combines mixed streams without sharing UTF-8 decoder state", () => {
  const stdout = new Utf8OutputTailBuffer(20);
  const stderr = new Utf8OutputTailBuffer(20);
  const combined = new ByteBoundedTextTail(20);
  const euro = Buffer.from("€", "utf8");

  stdout.append(euro.subarray(0, 1));
  stderr.append("E");
  combined.appendText(stderr.toString());
  stdout.append(euro.subarray(1));
  stdout.end();
  stderr.end();
  combined.appendText(stdout.toString());

  assert.equal(stdout.toString(), "€");
  assert.equal(stderr.toString(), "E");
  assert.equal(combined.toString(), "E€");
});

test("output snapshots do not consume decoder state", () => {
  const buffer = new Utf8OutputTailBuffer(20);
  const euro = Buffer.from("€", "utf8");
  buffer.append(euro.subarray(0, 1));
  assert.equal(buffer.toString(), "");
  assert.equal(buffer.toString(), "");
  buffer.append(euro.subarray(1));
  buffer.end();
  assert.equal(buffer.toString(), "€");
});

test("bounded tails match complete-codepoint suffixes across mixed Unicode and tiny caps", () => {
  const pieces = ["a", "€", "😀", "ב", "Ж", "x".repeat(100000), "tail😀", ""];
  for (const cap of [0, 1, 2, 3, 4, 5, 17, 128]) {
    const tail = new ByteBoundedTextTail(cap);
    let expected = "";
    for (let i = 0; i < 64; i++) {
      const text = pieces[(i * 13 + Math.floor(i / 8)) % pieces.length]!;
      let next = "";
      for (const char of [...(expected + text)].reverse()) {
        if (Buffer.byteLength(char + next) > cap) break;
        next = char + next;
      }
      expected = next; tail.appendText(text);
      assert.equal(tail.toString(), expected, `cap=${cap}, append=${i}`);
      assert.ok(Buffer.byteLength(tail.toString()) <= cap);
    }
  }
  for (const cap of [-1, NaN, Infinity, 0.5]) assert.throws(() => new ByteBoundedTextTail(cap), RangeError);
});

test("Utf8OutputTailBuffer decodes Windows CP866 console output without mojibake", () => {
  // CP866 bytes for: '"ver" не является'
  const cp866Bytes = Buffer.from([
    0x22, 0x76, 0x65, 0x72, 0x22, 0x20, 0xad, 0xa5, 0x20, 0xef, 0xa2, 0xab, 0xef, 0xa5, 0xe2, 0xe1, 0xef
  ]);
  const buffer = new Utf8OutputTailBuffer(100, "ibm866");
  buffer.append(cp866Bytes);
  buffer.end();
  assert.equal(buffer.toString(), '"ver" не является');
  assert.ok(!buffer.toString().includes("\uFFFD"));
});

test("Utf8OutputTailBuffer handles mixed ASCII and CP866 across chunk boundaries", () => {
  const buffer = new Utf8OutputTailBuffer(100, "ibm866");
  buffer.append(Buffer.from("cmd error: "));
  // 0xad 0xa5 is 'не' in CP866
  buffer.append(Buffer.from([0xad, 0xa5]));
  buffer.end();
  assert.equal(buffer.toString(), "cmd error: не");
});

test("Utf8OutputTailBuffer preserves valid UTF-8 Cyrillic without misclassifying as OEM", () => {
  const buffer = new Utf8OutputTailBuffer(100, "ibm866");
  const utf8Cyrillic = Buffer.from("Привет, мир!", "utf8");
  buffer.append(utf8Cyrillic);
  buffer.end();
  assert.equal(buffer.toString(), "Привет, мир!");
});

test("Utf8OutputTailBuffer recovers pending lead byte when followed by invalid UTF-8 byte in CP866", () => {
  const buffer = new Utf8OutputTailBuffer(100, "ibm866");
  // 0xe2 in CP866 is 'т', but looks like 3-byte UTF-8 lead byte
  buffer.append(Buffer.from([0xe2]));
  // 0x20 0xad is space + 'н' in CP866. It's not a valid UTF-8 continuation sequence.
  buffer.append(Buffer.from([0x20, 0xad]));
  buffer.end();
  assert.equal(buffer.toString(), "т н");
});

