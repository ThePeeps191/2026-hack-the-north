import { useEffect, useMemo, useState } from 'react';
import { DrawBoard } from './components/DrawBoard.tsx';
import { Lobby } from './components/Lobby.tsx';
import { Scoreboard } from './components/Scoreboard.tsx';
import { VoteGallery } from './components/VoteGallery.tsx';
import { useGame } from './useGame.ts';

const PHASE_LABEL: Record<string, string> = {
  lobby: 'Lobby',
  prompt: 'Prompt',
  draw: 'Draw',
  vote: 'Vote',
  results: 'Results',
};

function formatRemaining(ms: number | null, now: number): string {
  if (ms === null) {
    return '--';
  }
  const remaining = Math.max(0, Math.ceil((ms - now) / 1000));
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function App() {
  const game = useGame();
  const [name, setName] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const phaseEndsAt = game.state?.phaseEndsAt ?? null;
  useEffect(() => {
    if (phaseEndsAt === null) {
      return;
    }
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [phaseEndsAt]);

  const phase = game.state?.phase ?? 'lobby';
  const joined = Boolean(game.you);
  const connectedPlayers = useMemo(
    () => game.state?.players.filter((player) => player.connected) ?? [],
    [game.state],
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark">Sketch</span>
          <span className="mark-accent">Night</span>
        </div>
        <div className="top-meta">
          <span className="phase-pill" data-testid="phase-label">
            {PHASE_LABEL[phase] ?? phase}
          </span>
          <span className="timer" data-testid="round-timer">
            {formatRemaining(phaseEndsAt, now)}
          </span>
          <span className={`link-dot is-${game.status}`}>{game.status}</span>
        </div>
      </header>

      <div className="shell">
        <aside className="rail">
          <h2>Players</h2>
          <ul data-testid="player-list" className="player-list">
            {(game.state?.players ?? []).map((player) => (
              <li key={player.id} className={player.connected ? undefined : 'is-away'}>
                <span>{player.name}</span>
                <span className="muted">{player.connected ? `${player.score} pts` : 'away'}</span>
              </li>
            ))}
          </ul>
          {connectedPlayers.length === 0 ? (
            <p className="hint">Nobody is seated yet.</p>
          ) : null}
        </aside>

        <main className="stage">
          {game.error ? <p className="banner-error">{game.error}</p> : null}

          {phase === 'lobby' ? (
            <Lobby
              joined={joined}
              name={name}
              onNameChange={setName}
              onJoin={() => game.join(name)}
              onStart={game.start}
              canStart={joined && connectedPlayers.length > 0}
              playerCount={connectedPlayers.length}
            />
          ) : null}

          {phase === 'prompt' ? (
            <section className="panel prompt-card">
              <p className="kicker">This round</p>
              <h2>{game.state?.prompt ?? 'Waiting for a prompt'}</h2>
              <p className="hint">Pencils up when the draw timer starts.</p>
            </section>
          ) : null}

          {phase === 'draw' && joined ? (
            <DrawBoard
              prompt={game.state?.prompt ?? null}
              submitted={game.submitted}
              submittedCount={game.state?.sketches.length ?? 0}
              playerCount={connectedPlayers.length}
              onSubmit={game.submitSketch}
            />
          ) : null}

          {phase === 'draw' && !joined ? (
            <section className="panel">
              <h2>Draw</h2>
              <p className="hint">Join the room to draw this round.</p>
              <p className="hint" data-testid="submit-progress">
                {game.state?.sketches.length ?? 0} of {connectedPlayers.length} sketches in
              </p>
            </section>
          ) : null}

          {phase === 'vote' ? (
            <VoteGallery
              sketches={game.state?.sketches ?? []}
              youId={game.youId}
              voting={joined}
              votedSketchId={game.votedSketchId}
              onVote={game.vote}
            />
          ) : null}

          {phase === 'results' ? (
            <>
              <Scoreboard players={game.state?.players ?? []} onNextRound={game.nextRound} />
              <VoteGallery
                sketches={game.state?.sketches ?? []}
                youId={game.youId}
                voting={false}
                votedSketchId={game.votedSketchId}
                onVote={game.vote}
              />
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}
