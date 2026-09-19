import { createServer } from 'node:http';
import express from 'express';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import {
  DEFAULT_ROOM_ID,
  type ClientMessage,
  type HealthResponse,
  type ServerMessage,
} from '../shared/protocol.ts';
import { Game } from './game.ts';

const HOST = '127.0.0.1';
const PORT = 5274;
const DEV_ROUTES_ENABLED = process.env.SKETCH_NIGHT_DEV !== '0';

type SocketClient = {
  ws: WebSocket;
  playerId: string | null;
};

const game = new Game();
const clients = new Set<SocketClient>();

function room() {
  return game.room(DEFAULT_ROOM_ID);
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(): void {
  const state = room().snapshot();
  for (const client of clients) {
    if (!client.playerId || client.ws.readyState !== WebSocket.OPEN) {
      continue;
    }
    send(client.ws, { type: 'state', state, you: { id: client.playerId } });
  }
}

game.listener = () => broadcast();

function asText(data: RawData): string {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function handleMessage(client: SocketClient, raw: WebSocket.RawData): void {
  let message: ClientMessage;
  try {
    message = JSON.parse(asText(raw)) as ClientMessage;
  } catch {
    send(client.ws, { type: 'error', message: 'Invalid message' });
    return;
  }

  const current = room();
  try {
    switch (message.type) {
      case 'join': {
        const player = current.join(message.name, message.playerId);
        client.playerId = player.id;
        broadcast();
        break;
      }
      case 'start': {
        if (!client.playerId) {
          throw new Error('Join the room first');
        }
        current.start();
        broadcast();
        break;
      }
      case 'submit-sketch': {
        if (!client.playerId) {
          throw new Error('Join the room first');
        }
        current.submitSketch(client.playerId, message.imageDataUrl);
        broadcast();
        break;
      }
      case 'vote': {
        if (!client.playerId) {
          throw new Error('Join the room first');
        }
        current.vote(client.playerId, message.sketchId);
        broadcast();
        break;
      }
      case 'next-round': {
        if (!client.playerId) {
          throw new Error('Join the room first');
        }
        current.nextRound();
        broadcast();
        break;
      }
      default: {
        send(client.ws, { type: 'error', message: 'Unknown message' });
      }
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : 'Request failed';
    send(client.ws, { type: 'error', message: text });
  }
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  const current = room();
  const body: HealthResponse = {
    ok: true,
    phase: current.phase,
    players: current.players.length,
    round: current.round,
  };
  res.json(body);
});

app.post('/api/dev/reset', (_req, res) => {
  if (!DEV_ROUTES_ENABLED) {
    res.status(403).json({ error: 'Dev routes are disabled' });
    return;
  }
  const current = room();
  current.reset();
  // `broadcast()` skips clients that have no player id, so reset pushes the empty
  // lobby out explicitly. The empty `you.id` is a sentinel: the client cannot find
  // itself in the player list, drops its stored session and shows the join form
  // instead of painting a round that no longer exists.
  for (const client of clients) {
    client.playerId = null;
    send(client.ws, { type: 'state', state: current.snapshot(), you: { id: '' } });
  }
  res.json({ ok: true });
});

app.post('/api/dev/advance', (_req, res) => {
  if (!DEV_ROUTES_ENABLED) {
    res.status(403).json({ error: 'Dev routes are disabled' });
    return;
  }
  try {
    room().advance();
    broadcast();
    res.json({ ok: true, phase: room().phase, round: room().round });
  } catch (error) {
    const text = error instanceof Error ? error.message : 'Advance failed';
    res.status(400).json({ error: text });
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const client: SocketClient = { ws, playerId: null };
  clients.add(client);
  ws.on('message', (data) => handleMessage(client, data));
  ws.on('close', () => {
    clients.delete(client);
    if (client.playerId) {
      room().leave(client.playerId);
      broadcast();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`sketch-night server http://${HOST}:${PORT}`);
  if (DEV_ROUTES_ENABLED) {
    console.log('dev routes enabled (set SKETCH_NIGHT_DEV=0 to disable)');
  }
});
