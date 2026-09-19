import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, RoomState, ServerMessage } from '../shared/protocol.ts';

const SESSION_KEY = 'sketch-night-session';
const MAX_BACKOFF_MS = 8_000;

type Session = {
  id: string;
  name: string;
};

function readSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Session;
    if (!parsed.id || !parsed.name) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeSession(session: Session): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

export function useGame() {
  const [state, setState] = useState<RoomState | null>(null);
  const [youId, setYouId] = useState<string | null>(null);
  const [status, setStatus] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [votedSketchId, setVotedSketchId] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pendingName = useRef<string | null>(null);

  const send = useCallback((message: ClientMessage) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError('Not connected');
      return;
    }
    ws.send(JSON.stringify(message));
  }, []);

  useEffect(() => {
    let disposed = false;
    let attempt = 0;
    let retryTimer: number | undefined;
    let socket: WebSocket | null = null;

    const connect = () => {
      if (disposed) {
        return;
      }
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${location.host}/ws`);
      wsRef.current = socket;

      socket.onopen = () => {
        if (disposed) {
          return;
        }
        attempt = 0;
        setStatus('live');
        setError(null);
        const name = pendingName.current ?? readSession()?.name;
        const playerId = readSession()?.id;
        if (name) {
          socket?.send(JSON.stringify({ type: 'join', name, playerId } satisfies ClientMessage));
        }
      };

      socket.onmessage = (event) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          return;
        }
        if (message.type === 'error') {
          setError(message.message);
          return;
        }
        if (message.type === 'state') {
          setError(null);
          setState(message.state);
          setYouId(message.you.id);
          const name = pendingName.current ?? readSession()?.name;
          if (name) {
            writeSession({ id: message.you.id, name });
          }
          const self = message.state.players.find((player) => player.id === message.you.id);
          if (!self) {
            clearSession();
            pendingName.current = null;
            setYouId(null);
            setVotedSketchId(null);
          }
          if (message.state.phase !== 'vote' && message.state.phase !== 'results') {
            setVotedSketchId(null);
          }
        }
      };

      socket.onclose = () => {
        if (disposed) {
          return;
        }
        setStatus('reconnecting');
        const delay = Math.min(1_000 * 2 ** attempt, MAX_BACKOFF_MS);
        attempt += 1;
        retryTimer = window.setTimeout(connect, delay);
      };

      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      socket?.close();
      wsRef.current = null;
    };
  }, []);

  const join = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) {
        setError('Enter a display name');
        return;
      }
      pendingName.current = trimmed;
      const existing = readSession();
      send({ type: 'join', name: trimmed, playerId: existing?.id });
    },
    [send],
  );

  const start = useCallback(() => {
    send({ type: 'start' });
  }, [send]);

  const submitSketch = useCallback(
    (imageDataUrl: string) => {
      send({ type: 'submit-sketch', imageDataUrl });
    },
    [send],
  );

  const vote = useCallback(
    (sketchId: string) => {
      setVotedSketchId(sketchId);
      send({ type: 'vote', sketchId });
    },
    [send],
  );

  const nextRound = useCallback(() => {
    setVotedSketchId(null);
    send({ type: 'next-round' });
  }, [send]);

  const you = state?.players.find((player) => player.id === youId) ?? null;
  const submitted = Boolean(you && state?.sketches.some((sketch) => sketch.playerId === you.id));

  return {
    state,
    you,
    youId,
    status,
    error,
    votedSketchId,
    submitted,
    join,
    start,
    submitSketch,
    vote,
    nextRound,
  };
}
