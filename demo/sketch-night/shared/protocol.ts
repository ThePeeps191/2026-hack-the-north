export const DEFAULT_ROOM_ID = 'default';

export type Phase = 'lobby' | 'prompt' | 'draw' | 'vote' | 'results';

export type Player = {
  id: string;
  name: string;
  score: number;
  connected: boolean;
};

export type Sketch = {
  id: string;
  playerId: string;
  playerName: string;
  imageDataUrl: string;
  voters: string[];
};

export type RoomState = {
  roomId: string;
  phase: Phase;
  round: number;
  prompt: string | null;
  phaseEndsAt: number | null;
  players: Player[];
  sketches: Sketch[];
};

export type ClientMessage =
  | { type: 'join'; name: string; playerId?: string }
  | { type: 'start' }
  | { type: 'submit-sketch'; imageDataUrl: string }
  | { type: 'vote'; sketchId: string }
  | { type: 'next-round' };

export type ServerMessage =
  | { type: 'state'; state: RoomState; you: { id: string } }
  | { type: 'error'; message: string };

export type HealthResponse = {
  ok: true;
  phase: Phase;
  players: number;
  round: number;
};
