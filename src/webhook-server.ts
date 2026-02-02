import http from "node:http";
import { verifyGitHubSignature } from "./webhook-signature.js";

export type WebhookEvent = {
  event: string;
  delivery: string | null;
  payload: unknown;
};

export type WebhookServerOptions = {
  host: string;
  port: number;
  path: string;
  secret: string;
  maxPayloadBytes?: number;
  onEvent: (event: WebhookEvent) => Promise<void>;
  onLog?: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
};

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;

function respond(res: http.ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

export function startWebhookServer(options: WebhookServerOptions): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== options.path) {
      respond(res, 404, "Not found.");
      return;
    }
    if (req.method !== "POST") {
      respond(res, 405, "Method not allowed.");
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    const maxBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;

    req.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.length;
      if (received > maxBytes) {
        respond(res, 413, "Payload too large.");
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });

    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const signature = req.headers["x-hub-signature-256"];
      if (!verifyGitHubSignature(options.secret, body, Array.isArray(signature) ? signature[0] : signature)) {
        options.onLog?.("warn", "Webhook signature verification failed.");
        respond(res, 401, "Invalid signature.");
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        respond(res, 400, "Invalid JSON.");
        return;
      }

      const event = Array.isArray(req.headers["x-github-event"])
        ? req.headers["x-github-event"][0]
        : req.headers["x-github-event"] ?? "";
      const delivery = Array.isArray(req.headers["x-github-delivery"])
        ? req.headers["x-github-delivery"][0]
        : req.headers["x-github-delivery"] ?? null;

      if (!event) {
        respond(res, 400, "Missing event header.");
        return;
      }

      try {
        await options.onEvent({
          event,
          delivery,
          payload
        });
        respond(res, 200, "OK");
      } catch (error) {
        options.onLog?.("error", "Webhook handler failed.", {
          error: error instanceof Error ? error.message : String(error)
        });
        respond(res, 500, "Handler error.");
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(options.port, options.host, () => resolve(server));
  });
}
