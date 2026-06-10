import type { WebSocket } from "ws";
import type { ServerEvent } from "./types.js";

/** Send a JSON control/state event to the client (text frame). */
export function sendEvent(ws: WebSocket, ev: ServerEvent): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(ev));
  } catch {
    /* ignore send races */
  }
}

/** Send a raw PCM16 audio frame to the device (binary frame, must be <=640 B). */
export function sendAudioFrame(ws: WebSocket, frame: Buffer): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(frame, { binary: true });
  } catch {
    /* ignore send races */
  }
}
