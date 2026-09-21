import type { MessageHeaders } from "./api-spec.ts";

export const MAX_HEADER_BLOCK_BYTES = 256 * 1024;

const LF = 0x0a;
const CR = 0x0d;

const headerDecoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

export function headerBlock(source: Uint8Array): MessageHeaders {
  const block = source.subarray(0, headerBlockEnd(source));
  const truncated = block.length > MAX_HEADER_BLOCK_BYTES;
  const bounded = truncated ? block.subarray(0, MAX_HEADER_BLOCK_BYTES) : block;
  return { headers: headerDecoder.decode(bounded), truncated };
}

function headerBlockEnd(source: Uint8Array): number {
  let lineStart = 0;
  while (lineStart < source.length) {
    const lineFeed = source.indexOf(LF, lineStart);
    const lineEnd = lineFeed === -1 ? source.length : lineFeed;
    if (source.subarray(lineStart, lineEnd).every((byte) => byte === CR)) {
      return lineStart;
    }
    if (lineFeed === -1) {
      break;
    }
    lineStart = lineFeed + 1;
  }
  return source.length;
}
