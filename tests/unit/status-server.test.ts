import { describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startStatusServer } from "../../src/status-server.js";

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
  });
}

describe("status-server", () => {
  it("renders status page", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-ui-"));
    const server = await startStatusServer({
      workdirRoot: root,
      host: "127.0.0.1",
      port: 0
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected TCP address.");
      }
      const html = await fetchText(`http://127.0.0.1:${address.port}/`);
      expect(html).toContain("Agent Runner Status");
      expect(html).toContain("Running Tasks");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
