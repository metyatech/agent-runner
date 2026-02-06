const UTF16_ZERO_RATIO = 0.25;

function countZeroBytes(buffer: Buffer): number {
  let zeros = 0;
  for (const byte of buffer.values()) {
    if (byte === 0) {
      zeros += 1;
    }
  }
  return zeros;
}

function decodeBuffer(buffer: Buffer): string {
  if (buffer.length === 0) {
    return "";
  }
  const zeroRatio = countZeroBytes(buffer) / buffer.length;
  if (zeroRatio >= UTF16_ZERO_RATIO) {
    return buffer.toString("utf16le");
  }
  return buffer.toString("utf8");
}

function normalizeText(value: string): string {
  return value.replace(/\u0000/g, "").replace(/\r(?!\n)/g, "\n");
}

export function normalizeLogChunk(chunk: Buffer | string): string {
  if (typeof chunk === "string") {
    return normalizeText(chunk);
  }
  const decoded = decodeBuffer(chunk);
  return normalizeText(decoded);
}
