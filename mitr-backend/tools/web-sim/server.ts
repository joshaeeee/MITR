import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

const port = Number(process.env.WEB_SIM_PORT ?? 8787);
const pagesRoot = resolve(process.cwd(), 'tools/web-sim');
const indexPath = resolve(process.cwd(), 'tools/web-sim/index.html');
const assetsRoot = resolve(process.cwd(), 'tools/web-sim/assets');

type BridgeRole = 'source' | 'sink';

type BridgeMeta = {
  type: 'format';
  room: string;
  sampleRate: number;
  channels: number;
  format: 'pcm_s16le';
};

type BridgeControl = {
  type: 'control';
  room: string;
  action: 'tone_start' | 'tone_stop';
};

type BridgePeerState = {
  role: BridgeRole | null;
  room: string | null;
};

type RoomBridge = {
  source: WebSocket | null;
  sinks: Set<WebSocket>;
  meta: BridgeMeta | null;
  forwardedPackets: number;
  forwardedBytes: number;
};

const roomBridges = new Map<string, RoomBridge>();
const peerStates = new WeakMap<WebSocket, BridgePeerState>();

const getOrCreateRoomBridge = (room: string): RoomBridge => {
  let bridge = roomBridges.get(room);
  if (!bridge) {
    bridge = { source: null, sinks: new Set(), meta: null, forwardedPackets: 0, forwardedBytes: 0 };
    roomBridges.set(room, bridge);
  }
  return bridge;
};

const removePeerFromRoom = (socket: WebSocket) => {
  const state = peerStates.get(socket);
  if (!state?.room) return;
  const bridge = roomBridges.get(state.room);
  if (!bridge) return;

  if (state.role === 'source' && bridge.source === socket) {
    bridge.source = null;
  }
  if (state.role === 'sink') {
    bridge.sinks.delete(socket);
  }

  if (!bridge.source && bridge.sinks.size === 0) {
    roomBridges.delete(state.room);
  }
};

const safeSendJson = (socket: WebSocket, payload: unknown) => {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
};

const contentTypeFor = (path: string): string => {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.mp3')) return 'audio/mpeg';
  if (path.endsWith('.ogg') || path.endsWith('.oga')) return 'audio/ogg';
  if (path.endsWith('.wav')) return 'audio/wav';
  if (path.endsWith('.webm')) return 'audio/webm';
  if (path.endsWith('.flac')) return 'audio/flac';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  if (path.endsWith('.md') || path.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
};

const server = createServer(async (req, res) => {
  if (!req.url || req.url === '/' || req.url.startsWith('/index')) {
    try {
      const html = await readFile(indexPath, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Failed to load simulator page: ${(error as Error).message}`);
      return;
    }
  }

  if (req.url === '/esp32-agent' || req.url === '/esp32-agent.html') {
    try {
      const html = await readFile(resolve(pagesRoot, 'esp32-agent.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Failed to load ESP32 simulator page: ${(error as Error).message}`);
      return;
    }
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url.startsWith('/assets/')) {
    try {
      const decoded = decodeURIComponent(req.url.slice('/assets/'.length));
      const normalized = decoded.replace(/^\/+/, '');
      const filePath = resolve(assetsRoot, normalized);
      if (!filePath.startsWith(assetsRoot)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      const file = await readFile(filePath);
      res.writeHead(200, { 'content-type': contentTypeFor(filePath), 'cache-control': 'public, max-age=3600' });
      res.end(file);
      return;
    } catch (error) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Asset not found: ${(error as Error).message}`);
      return;
    }
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(port, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`Mitr web simulator running at http://localhost:${port}`);
});

const wss = new WebSocketServer({
  server,
  path: '/esp32-audio'
});

wss.on('connection', (socket) => {
  peerStates.set(socket, { role: null, room: null });

  socket.on('message', (message, isBinary) => {
    const state = peerStates.get(socket);
    if (!state) return;

    if (isBinary) {
      if (state.role !== 'source' || !state.room) return;
      const bridge = roomBridges.get(state.room);
      if (!bridge || bridge.source !== socket) return;
      bridge.forwardedPackets += 1;
      bridge.forwardedBytes += message.length;
      if (bridge.forwardedPackets === 1 || bridge.forwardedPackets % 25 === 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[esp32-audio] room=${state.room} packets=${bridge.forwardedPackets} bytes=${bridge.forwardedBytes} sinks=${bridge.sinks.size}`
        );
      }
      for (const sink of bridge.sinks) {
        if (sink.readyState === WebSocket.OPEN) {
          sink.send(message, { binary: true });
        }
      }
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(message.toString());
    } catch {
      safeSendJson(socket, { type: 'error', message: 'invalid_json' });
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      safeSendJson(socket, { type: 'error', message: 'invalid_message' });
      return;
    }

    if (parsed.type === 'init') {
      const role = parsed.role === 'source' ? 'source' : parsed.role === 'sink' ? 'sink' : null;
      const room = typeof parsed.room === 'string' ? parsed.room.trim() : '';
      if (!role || !room) {
        safeSendJson(socket, { type: 'error', message: 'missing_role_or_room' });
        return;
      }

      removePeerFromRoom(socket);
      const bridge = getOrCreateRoomBridge(room);
      peerStates.set(socket, { role, room });

      if (role === 'source') {
        if (bridge.source && bridge.source !== socket && bridge.source.readyState === WebSocket.OPEN) {
          safeSendJson(bridge.source, { type: 'status', status: 'superseded' });
          bridge.source.close();
        }
        bridge.source = socket;
        if (
          parsed.sampleRate &&
          parsed.channels &&
          parsed.format === 'pcm_s16le'
        ) {
          bridge.meta = {
            type: 'format',
            room,
            sampleRate: Number(parsed.sampleRate),
            channels: Number(parsed.channels),
            format: 'pcm_s16le'
          };
        }
        safeSendJson(socket, { type: 'status', status: 'source_ready', room });
        if (bridge.meta) {
          for (const sink of bridge.sinks) {
            safeSendJson(sink, bridge.meta);
          }
        }
        return;
      }

      bridge.sinks.add(socket);
      safeSendJson(socket, { type: 'status', status: 'sink_ready', room });
      if (bridge.meta) {
        safeSendJson(socket, bridge.meta);
      } else {
        safeSendJson(socket, { type: 'status', status: 'waiting_for_source', room });
      }
      return;
    }

    if (parsed.type === 'format') {
      if (state.role !== 'source' || !state.room) return;
      const bridge = roomBridges.get(state.room);
      if (!bridge) return;
      bridge.meta = {
        type: 'format',
        room: state.room,
        sampleRate: Number(parsed.sampleRate),
        channels: Number(parsed.channels),
        format: 'pcm_s16le'
      };
      for (const sink of bridge.sinks) {
        safeSendJson(sink, bridge.meta);
      }
      return;
    }

    if (parsed.type === 'control') {
      if (state.role !== 'source' || !state.room) return;
      const bridge = roomBridges.get(state.room);
      if (!bridge) return;
      const action = parsed.action === 'tone_start' ? 'tone_start' : parsed.action === 'tone_stop' ? 'tone_stop' : null;
      if (!action) return;
      const payload: BridgeControl = {
        type: 'control',
        room: state.room,
        action
      };
      for (const sink of bridge.sinks) {
        safeSendJson(sink, payload);
      }
      // eslint-disable-next-line no-console
      console.log(`[esp32-audio] room=${state.room} control=${action} sinks=${bridge.sinks.size}`);
      return;
    }
  });

  socket.on('close', () => {
    removePeerFromRoom(socket);
    peerStates.delete(socket);
  });
});
