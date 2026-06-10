import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { config, validateConfig } from "./config.js";
import { log } from "./logger.js";
import { authenticate, selectSubprotocol } from "./auth.js";
import { providerLabel } from "./providers/index.js";
import { Session } from "./session.js";
import { sendEvent } from "./state.js";

validateConfig();

const logc = log.child({ mod: "server" });
const activeByKey = new Map<string, WebSocket>();
let shuttingDown = false;

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const path = (req.url ?? "").split("?")[0];
  if (req.method === "GET" && path === "/healthz") {
    if (shuttingDown) {
      json(res, 503, { ok: false, draining: true });
      return;
    }
    json(res, 200, { ok: true, provider: providerLabel() });
    return;
  }
  if (req.method === "POST" && path === "/connect") {
    json(res, 200, { wsUrl: config.publicWsUrl, protocol: config.protocol });
    return;
  }
  json(res, 404, { error: "not found" });
});

const wss = new WebSocketServer({
  noServer: true,
  // One audio packet is 640 B; anything near 100 MiB (the ws default) is an attack.
  maxPayload: 64 * 1024,
  // Echo back the mitr-pcm16 subprotocol when the client requests it.
  handleProtocols: (_protocols, req) => selectSubprotocol(req as IncomingMessage) ?? false,
});

httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const path = (req.url ?? "").split("?")[0];
  if (path !== "/ws" || shuttingDown) {
    socket.write(shuttingDown ? "HTTP/1.1 503 Service Unavailable\r\n\r\n" : "HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  // Browser clients send Origin; enforce the allowlist when one is configured.
  // (Devices send no Origin header and are unaffected.)
  const origin = req.headers.origin;
  if (origin && config.corsOrigins.length > 0 && !config.corsOrigins.includes(origin)) {
    logc.warn("ws origin rejected", { origin });
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  authenticate(req)
    .then((auth) => {
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, auth));
    })
    .catch((err) => {
      logc.warn("ws auth rejected", { error: String(err) });
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
    });
});

function onConnection(ws: WebSocket, auth: Awaited<ReturnType<typeof authenticate>>): void {
  const key = auth.deviceId || auth.userId || "anonymous";

  // Supersede any previous live connection for this device/user.
  const prev = activeByKey.get(key);
  if (prev && prev !== ws) {
    sendEvent(prev, { type: "session_superseded", deviceId: auth.deviceId });
    try {
      prev.close(4000);
    } catch {
      /* ignore */
    }
  }
  activeByKey.set(key, ws);

  // Handshake: first server frame is the 'ready' event (protocol contract).
  sendEvent(ws, {
    type: "ready",
    protocol: config.protocol,
    audioIn: { sampleRate: config.audioInSampleRate },
    audioOut: { sampleRate: config.audioOutSampleRate },
    deviceId: auth.deviceId,
  });

  const session = new Session(ws, auth);
  session.start().catch((err) => {
    logc.error("session start failed", { deviceId: auth.deviceId, error: String(err) });
    sendEvent(ws, {
      type: "gateway_error",
      source: "session",
      message: String(err),
      fatal: true,
      deviceId: auth.deviceId,
    });
    try {
      ws.close(1011);
    } catch {
      /* ignore */
    }
  });

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) session.handleBinary(data);
    else session.handleText(data.toString());
  });

  ws.on("close", () => {
    void session.stop();
    if (activeByKey.get(key) === ws) activeByKey.delete(key);
  });

  ws.on("error", (err) => {
    logc.warn("ws error", { deviceId: auth.deviceId, error: String(err) });
  });
}

httpServer.listen(config.port, config.host, () => {
  logc.info("voice-gateway listening", {
    host: config.host,
    port: config.port,
    provider: providerLabel(),
    audioIn: config.audioInSampleRate,
    audioOut: config.audioOutSampleRate,
    authMode: config.authMode,
  });
});

// One rejected promise must not silently tear down every live device session.
process.on("unhandledRejection", (reason) => {
  logc.error("unhandled rejection", { error: String(reason) });
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  logc.error("uncaught exception", { error: String(err) });
  process.exit(1);
});

function shutdown(sig: string): void {
  shuttingDown = true; // healthz -> 503, new upgrades rejected, existing sessions drain
  logc.info("shutting down", { sig });
  for (const ws of activeByKey.values()) {
    try {
      ws.close(1001);
    } catch {
      /* ignore */
    }
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
