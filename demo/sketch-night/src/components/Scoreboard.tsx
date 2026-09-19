import type { Player } from '../../shared/protocol.ts';

type ScoreboardProps = {
  players: Player[];
  onNextRound: () => void;
};

export function Scoreboard({ players, onNextRound }: ScoreboardProps) {
  const ranked = [...players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return (
    <section className="panel">
      <div className="score-head">
        <h2>Results</h2>
        <button type="button" className="btn-primary" data-testid="next-round" onClick={onNextRound}>
          Next round
        </button>
      </div>
      <ol className="scoreboard" data-testid="scoreboard">
        {ranked.map((player, index) => (
          <li key={player.id}>
            <span className="rank">{index + 1}</span>
            <span className={player.connected ? 'name' : 'name is-away'}>{player.name}</span>
            <span className="score">{player.score}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
