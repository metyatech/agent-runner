import crypto from "node:crypto";

export function computeGitHubSignature(secret: string, payload: Buffer): string {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(payload);
  return `sha256=${hmac.digest("hex")}`;
}

export function verifyGitHubSignature(secret: string, payload: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const expected = computeGitHubSignature(secret, payload);
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signatureHeader);
  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}
