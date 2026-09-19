import { randomUUID } from 'node:crypto';
import {
  DEFAULT_ROOM_ID,
  type Phase,
  type Player,
  type RoomState,
  type Sketch,
} from '../shared/protocol.ts';
import { pickPrompt } from './prompts.ts';

export const PROMPT_MS = 4_000;
export const DRAW_MS = 60_000;
export const VOTE_MS = 30_000;

export class GameRoom {
  readonly id: string;
  phase: Phase = 'lobby';
  round = 0;
  prompt: string | null = null;
  phaseEndsAt: number | null = null;
  players: Player[] = [];
  sketches: Sketch[] = [];
  onChange: () => void = () => {};

  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(id = DEFAULT_ROOM_ID) {
    this.id = id;
  }

  snapshot(): RoomState {
    return {
      roomId: this.id,
      phase: this.phase,
      round: this.round,
      prompt: this.prompt,
      phaseEndsAt: this.phaseEndsAt,
      players: this.players.map((player) => ({ ...player })),
      sketches: this.sketches.map((sketch) => ({
        ...sketch,
        voters: [...sketch.voters],
      })),
    };
  }

  join(name: string, playerId?: string): Player {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('Name is required');
    }
    if (trimmed.length > 24) {
      throw new Error('Name is too long');
    }

    if (playerId) {
      const existing = this.players.find((player) => player.id === playerId);
      if (existing) {
        existing.connected = true;
        existing.name = trimmed;
        return existing;
      }
    }

    const player: Player = {
      id: playerId ?? randomUUID(),
      name: trimmed,
      score: 0,
      connected: true,
    };
    this.players.push(player);
    return player;
  }

  leave(playerId: string): void {
    const player = this.players.find((item) => item.id === playerId);
    if (player) {
      player.connected = false;
    }
  }

  start(): void {
    if (this.phase !== 'lobby') {
      throw new Error('The round has already started');
    }
    this.startRound();
  }

  submitSketch(playerId: string, imageDataUrl: string): void {
    if (this.phase !== 'draw') {
      throw new Error('Drawing is closed');
    }
    const player = this.requirePlayer(playerId);
    if (!imageDataUrl.startsWith('data:image/png')) {
      throw new Error('Sketch must be a PNG data URL');
    }
    if (this.sketches.some((sketch) => sketch.playerId === playerId)) {
      throw new Error('You already submitted a sketch');
    }
    this.sketches.push({
      id: randomUUID(),
      playerId,
      playerName: player.name,
      imageDataUrl,
      voters: [],
    });
  }

  vote(playerId: string, sketchId: string): void {
    if (this.phase !== 'vote') {
      throw new Error('Voting is closed');
    }
    const player = this.requirePlayer(playerId);
    const sketch = this.sketches.find((item) => item.id === sketchId);
    if (!sketch) {
      throw new Error('Sketch not found');
    }
    if (sketch.playerId === playerId) {
      throw new Error('You cannot vote for your own sketch');
    }
    sketch.voters.push(player.name);
  }

  nextRound(): void {
    if (this.phase !== 'results') {
      throw new Error('The round is still in play');
    }
    this.startRound();
  }

  reset(): void {
    this.clearTimer();
    this.phase = 'lobby';
    this.round = 0;
    this.prompt = null;
    this.phaseEndsAt = null;
    this.players = [];
    this.sketches = [];
  }

  advance(): void {
    switch (this.phase) {
      case 'lobby':
        this.startRound();
        break;
      case 'prompt':
        this.beginDraw();
        break;
      case 'draw':
        this.beginVote();
        break;
      case 'vote':
        this.beginResults();
        break;
      case 'results':
        this.startRound();
        break;
    }
  }

  private startRound(): void {
    if (!this.players.some((player) => player.connected)) {
      throw new Error('Need at least one connected player');
    }
    this.round += 1;
    this.sketches = [];
    this.beginPrompt();
  }

  private beginPrompt(): void {
    this.phase = 'prompt';
    this.prompt = pickPrompt(this.prompt);
    this.arm(PROMPT_MS, () => this.beginDraw());
  }

  private beginDraw(): void {
    this.phase = 'draw';
    this.arm(DRAW_MS, () => this.beginVote());
  }

  private beginVote(): void {
    this.phase = 'vote';
    this.arm(VOTE_MS, () => this.beginResults());
  }

  private beginResults(): void {
    this.clearTimer();
    this.phase = 'results';
    this.phaseEndsAt = null;
    for (const sketch of this.sketches) {
      const author = this.players.find((player) => player.id === sketch.playerId);
      if (author) {
        author.score += sketch.voters.length;
      }
    }
  }

  private requirePlayer(playerId: string): Player {
    const player = this.players.find((item) => item.id === playerId);
    if (!player) {
      throw new Error('Join the room first');
    }
    return player;
  }

  private arm(ms: number, next: () => void): void {
    this.clearTimer();
    this.phaseEndsAt = Date.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      next();
      this.onChange();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export class Game {
  readonly rooms = new Map<string, GameRoom>();
  listener: (room: GameRoom) => void = () => {};

  room(id = DEFAULT_ROOM_ID): GameRoom {
    const existing = this.rooms.get(id);
    if (existing) {
      return existing;
    }
    const created = new GameRoom(id);
    created.onChange = () => this.listener(created);
    this.rooms.set(id, created);
    return created;
  }
}
