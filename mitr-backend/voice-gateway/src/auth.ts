import type { IncomingMessage } from "node:http";
import { config } from "./config.js";
import type { DeviceAuthContext } from "./types.js";

const AUTH_TOKEN_SUBPROTOCOL_PREFIX = "mitr-token-";
export const PCM16_SUBPROTOCOL = "mitr-pcm16";

export class AuthError extends Error {}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function query(req: IncomingMessage): URLSearchParams {
  const url = req.url ?? "";
  const qIdx = url.indexOf("?");
  return new URLSearchParams(qIdx >= 0 ? url.slice(qIdx + 1) : "");
}

function bearer(req: IncomingMessage): string | undefined {
  const authz = header(req, "authorization");
  if (!authz) return undefined;
  const [scheme, ...rest] = authz.split(" ");
  const token = rest.join(" ").trim();
  if ((scheme ?? "").toLowerCase() !== "bearer" || !token) return undefined;
  return token;
}

function subprotocolToken(req: IncomingMessage): string | undefined {
  const protocols = header(req, "sec-websocket-protocol") ?? "";
  for (const p of protocols.split(",")) {
    const v = p.trim();
    if (v.startsWith(AUTH_TOKEN_SUBPROTOCOL_PREFIX)) {
      const t = v.slice(AUTH_TOKEN_SUBPROTOCOL_PREFIX.length).trim();
      if (t) return t;
    }
  }
  return undefined;
}

/** Pick the negotiated subprotocol to echo back on accept (mirrors Pipecat gateway). */
export function selectSubprotocol(req: IncomingMessage): string | undefined {
  const protocols = header(req, "sec-websocket-protocol") ?? "";
  const requested = new Set(protocols.split(",").map((p) => p.trim()).filter(Boolean));
  return requested.has(PCM16_SUBPROTOCOL) ? PCM16_SUBPROTOCOL : undefined;
}

async function postBackend(path: string, token: string, body: unknown): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    return await fetch(`${config.backendBaseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Authenticate a device/web WebSocket upgrade. Mirrors the Pipecat gateway auth.py
 * contract so the existing firmware and backend work unchanged.
 */
export async function authenticate(req: IncomingMessage): Promise<DeviceAuthContext> {
  const q = query(req);
  const deviceId = q.get("deviceId") || header(req, "x-mitr-device-id") || "";
  const language = q.get("language") || header(req, "x-mitr-language") || "hi-IN";
  const timezone = q.get("timezone") || header(req, "x-mitr-timezone") || null;
  const client = q.get("client") || header(req, "x-mitr-client") || "esp32";

  if (config.authMode === "local") {
    const expected = config.localDeviceId.trim();
    if (expected && deviceId !== expected) throw new AuthError("local auth rejected device id");
    if (!deviceId) throw new AuthError("local auth requires device id");
    return { deviceId, language, timezone };
  }

  const token = bearer(req) || subprotocolToken(req);
  if (!token) throw new AuthError("missing bearer token");
  if (!config.backendBaseUrl) throw new AuthError("MITR_BACKEND_BASE_URL is required");

  // Web client (or missing deviceId) authenticates against the user-session endpoint.
  if (client === "web" || !deviceId) {
    const res = await postBackend("/pipecat/gateway/auth", token, {
      language,
      transport: "voice-gateway",
    });
    if (res.status >= 400) throw new AuthError(`backend web auth rejected: ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    const userId = String(data.userId ?? "unknown-user");
    return {
      deviceId: String(data.deviceId ?? `web-${userId}`),
      userId,
      userName: (data.userName as string) ?? null,
      familyId: (data.familyId as string) ?? null,
      elderId: (data.elderId as string) ?? null,
      elderName: (data.elderName as string) ?? null,
      language: String(data.language ?? language ?? "hi-IN"),
      timezone: String(data.timezone ?? data.timeZone ?? timezone ?? "") || null,
    };
  }

  const res = await postBackend("/devices/gateway/auth", token, {
    deviceId,
    language,
    transport: "voice-gateway",
  });
  if (res.status >= 400) throw new AuthError(`backend auth rejected device: ${res.status}`);
  const data = (await res.json()) as Record<string, unknown>;
  return {
    deviceId: String(data.deviceId ?? deviceId ?? "unknown-device"),
    userId: (data.userId as string) ?? null,
    userName: (data.userName as string) ?? null,
    familyId: (data.familyId as string) ?? null,
    elderId: (data.elderId as string) ?? null,
    elderName: (data.elderName as string) ?? null,
    language: String(data.language ?? language ?? "hi-IN"),
    timezone: String(data.timezone ?? data.timeZone ?? timezone ?? "") || null,
  };
}
