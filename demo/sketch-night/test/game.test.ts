/**
 * Headless tests for the Sketch Night round logic.
 *
 * No browser, no WebSocket, no network: these exercise `GameRoom` directly.
 * Run with `npm test` (node's built-in test runner + type stripping).
 *
 * Three tests pin CURRENT behaviour on purpose, so that changing the behaviour
 * makes them fail loudly instead of silently drifting:
 *
 *   1. "BUG 1" - the draw phase does not end early when every player has submitted.
 *   2. "BUG 2" - a player can vote twice after reloading (rejoin with same id).
 *   3. "PUBLIC VOTING" - the room snapshot exposes voter display names.
 *
 * See BUG_REPORT.md (bugs 1 and 2) and FEATURE_NOTES.md (public voting decision).
 * When the product decision changes, update the assertion - that is the point.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DRAW_MS, Game, GameRoom, PROMPT_MS, VOTE_MS } from '../server/game.ts';
import { DEFAULT_ROOM_ID, type RoomState, type Sketch } from '../shared/protocol.ts';

/** 1x1 transparent PNG, the smallest thing `submitSketch` accepts. */
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

function roomWithTable(): GameRoom {
  const room = new GameRoom(DEFAULT_ROOM_ID);
  room.join('Alice');
  room.join('Bob');
  return room;
}

function playerId(room: GameRoom, name: string): string {
  const player = room.players.find((item) => item.name === name);
  assert.ok(player, `expected a player named ${name}`);
  return player.id;
}

function sketchBy(room: GameRoom, playerIdValue: string): Sketch {
  const sketch = room.sketches.find((item) => item.playerId === playerIdValue);
  assert.ok(sketch, 'expected that player to have submitted a sketch');
  return sketch;
}

/**
 * Two players, round started, both sketches submitted, phase = `vote`.
 * Uses `advance()` so the test never waits on a real timer.
 */
function tableInVoting(): GameRoom {
  const room = roomWithTable();
  room.start();
  room.advance();
  assert.equal(room.phase, 'draw');
  room.submitSketch(playerId(room, 'Alice'), PNG_DATA_URL);
  room.submitSketch(playerId(room, 'Bob'), PNG_DATA_URL);
  room.advance();
  assert.equal(room.phase, 'vote');
  return room;
}

describe('round loop', () => {
  it('walks lobby -> prompt -> draw -> vote -> results through advance()', () => {
    const room = roomWithTable();
    try {
      assert.equal(room.phase, 'lobby');
      room.start();
      assert.equal(room.phase, 'prompt');
      assert.ok(room.prompt, 'a prompt should be picked');
      room.advance();
      assert.equal(room.phase, 'draw');
      room.advance();
      assert.equal(room.phase, 'vote');
      room.advance();
      assert.equal(room.phase, 'results');
      assert.equal(room.phaseEndsAt, null);
    } finally {
      room.reset();
    }
  });

  it('refuses to start a round with nobody connected', () => {
    const room = new GameRoom(DEFAULT_ROOM_ID);
    assert.throws(() => room.start(), /connected player/);
  });

  it('reset() puts the room back to an empty lobby', () => {
    const room = roomWithTable();
    room.start();
    room.reset();
    assert.equal(room.phase, 'lobby');
    assert.equal(room.round, 0);
    assert.equal(room.players.length, 0);
    assert.equal(room.sketches.length, 0);
    assert.equal(room.phaseEndsAt, null);
  });
});

describe('voting', () => {
  it('records a vote as the voter display name on the target sketch', () => {
    const room = tableInVoting();
    try {
      const alice = sketchBy(room, playerId(room, 'Alice'));
      room.vote(playerId(room, 'Bob'), alice.id);
      assert.deepEqual(alice.voters, ['Bob']);
    } finally {
      room.reset();
    }
  });

  it('rejects a vote for your own sketch', () => {
    const room = tableInVoting();
    try {
      const alice = playerId(room, 'Alice');
      assert.throws(() => room.vote(alice, sketchBy(room, alice).id), /own sketch/);
    } finally {
      room.reset();
    }
  });

  it('rejects votes outside the vote phase and for unknown sketches', () => {
    const room = roomWithTable();
    try {
      assert.throws(() => room.vote(playerId(room, 'Alice'), 'nope'), /Voting is closed/);
      room.start();
      room.advance();
      assert.equal(room.phase, 'draw');
      assert.throws(() => room.vote(playerId(room, 'Alice'), 'nope'), /Voting is closed/);
      room.advance();
      assert.equal(room.phase, 'vote');
      assert.throws(() => room.vote(playerId(room, 'Alice'), 'nope'), /Sketch not found/);
    } finally {
      room.reset();
    }
  });

  it('scores each sketch by its vote count when results start', () => {
    const room = tableInVoting();
    try {
      const alice = playerId(room, 'Alice');
      const bob = playerId(room, 'Bob');
      room.vote(bob, sketchBy(room, alice).id);
      room.advance();
      assert.equal(room.phase, 'results');
      assert.equal(room.players.find((item) => item.id === alice)?.score, 1);
      assert.equal(room.players.find((item) => item.id === bob)?.score, 0);
    } finally {
      room.reset();
    }
  });

  it('BUG 2 (current behaviour): a voter can vote twice after a reload', () => {
    // A reload drops the socket; the client keeps its player id in sessionStorage
    // and rejoins with it (see src/useGame.ts SESSION_KEY). The server re-uses the
    // same player and `vote()` does not remember that this player already voted.
    const room = tableInVoting();
    try {
      const bob = playerId(room, 'Bob');
      const alice = playerId(room, 'Alice');
      const aliceSketch = sketchBy(room, alice);

      room.vote(bob, aliceSketch.id);
      assert.deepEqual(aliceSketch.voters, ['Bob']);

      room.leave(bob); // socket closed
      const rejoined = room.join('Bob', bob); // client re-sends join with its stored id
      assert.equal(rejoined.id, bob, 'rejoin re-uses the stored player id');

      room.vote(bob, aliceSketch.id); // accepted today - the bug
      assert.deepEqual(
        aliceSketch.voters,
        ['Bob', 'Bob'],
        'BUG 2: the same display name is recorded twice',
      );

      room.advance(); // -> results
      assert.equal(
        room.players.find((item) => item.id === alice)?.score,
        2,
        'BUG 2: the duplicate vote is also scored twice',
      );
    } finally {
      room.reset();
    }
  });
});

describe('phase timers', () => {
  it('expires the prompt phase into draw on the timer', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const room = roomWithTable();
    room.start();
    assert.equal(room.phase, 'prompt');
    assert.ok(room.phaseEndsAt !== null);

    t.mock.timers.tick(PROMPT_MS - 1);
    assert.equal(room.phase, 'prompt');
    t.mock.timers.tick(1);
    assert.equal(room.phase, 'draw');

    room.reset();
  });

  it('expires the vote phase into results on the timer', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const room = tableInVoting();
    t.mock.timers.tick(VOTE_MS - 1);
    assert.equal(room.phase, 'vote');
    t.mock.timers.tick(1);
    assert.equal(room.phase, 'results');
    assert.equal(room.phaseEndsAt, null);
    room.reset();
  });

  it('BUG 1 (current behaviour): the draw phase runs its full timer even when everyone is in', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const room = roomWithTable();
    room.start();
    t.mock.timers.tick(PROMPT_MS);
    assert.equal(room.phase, 'draw');
    const drawEndsAt = room.phaseEndsAt;

    room.submitSketch(playerId(room, 'Alice'), PNG_DATA_URL);
    room.submitSketch(playerId(room, 'Bob'), PNG_DATA_URL);
    assert.equal(room.sketches.length, 2);

    // Every connected player has submitted, yet the phase is unchanged...
    assert.equal(room.phase, 'draw', 'BUG 1: submits do not end the draw phase');
    assert.equal(room.phaseEndsAt, drawEndsAt, 'BUG 1: the draw timer keeps its deadline');

    // ...and it only moves on when the 60 second window runs out.
    t.mock.timers.tick(DRAW_MS - 1);
    assert.equal(room.phase, 'draw');
    t.mock.timers.tick(1);
    assert.equal(room.phase, 'vote');

    room.reset();
  });
});

describe('wire payload shape', () => {
  it('PUBLIC VOTING (current behaviour): voter display names are in the state payload', () => {
    // FEATURE_NOTES.md, decided 2026-09-12: "Voting is public. Players can see who
    // voted for which sketch". README.md documents the same thing. This test asserts
    // that the payload really does leak voter identity, so an anonymity change shows
    // up as a failing test rather than a silent behaviour change.
    const room = tableInVoting();
    try {
      const alice = playerId(room, 'Alice');
      room.vote(playerId(room, 'Bob'), sketchBy(room, alice).id);

      const state: RoomState = room.snapshot();
      const sketch = sketchBy(room, alice);
      const wire = JSON.stringify(state);

      assert.ok(Array.isArray(sketch.voters), 'sketch.voters is an array');
      assert.deepEqual(sketch.voters, ['Bob'], 'voter identity is per-sketch and by display name');
      assert.match(wire, /"voters":\["Bob"\]/, 'voter identity travels on the socket');
      assert.equal(sketch.playerName, 'Alice', 'the author is named on the tile too');
      assert.equal(Object.prototype.hasOwnProperty.call(state.sketches[0], 'voters'), true);
    } finally {
      room.reset();
    }
  });

  it('Game.room() hands back the same room instance per id and wires onChange', () => {
    const game = new Game();
    const seen: string[] = [];
    game.listener = (changed) => seen.push(changed.id);

    const first = game.room(DEFAULT_ROOM_ID);
    const second = game.room(DEFAULT_ROOM_ID);
    assert.equal(first, second);

    first.onChange();
    assert.deepEqual(seen, [DEFAULT_ROOM_ID]);

    const other = game.room('other-room');
    assert.notEqual(other, first);
    assert.equal(game.rooms.size, 2);

    first.reset();
    other.reset();
  });
});
