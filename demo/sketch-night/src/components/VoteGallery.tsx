import type { Sketch } from '../../shared/protocol.ts';

type VoteGalleryProps = {
  sketches: Sketch[];
  youId: string | null;
  voting: boolean;
  votedSketchId: string | null;
  onVote: (sketchId: string) => void;
};

export function VoteGallery({
  sketches,
  youId,
  voting,
  votedSketchId,
  onVote,
}: VoteGalleryProps) {
  if (sketches.length === 0) {
    return (
      <section className="panel">
        <h2>{voting ? 'Vote' : 'Sketches'}</h2>
        <div data-testid="sketch-gallery" className="gallery empty-gallery">
          <p className="hint">No sketches were submitted this round.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>{voting ? 'Vote' : 'Sketches'}</h2>
      <p className="lede">
        {!youId
          ? 'Join the room to vote for a sketch.'
          : voting
            ? 'Pick one sketch that is not your own. Votes are public.'
            : 'Public votes for this round.'}
      </p>
      <div data-testid="sketch-gallery" className="gallery">
        {sketches.map((sketch) => {
          const own = sketch.playerId === youId;
          const alreadyVoted = Boolean(votedSketchId);
          const selected = votedSketchId === sketch.id;
          return (
            <article
              key={sketch.id}
              className={selected ? 'sketch-tile is-selected' : 'sketch-tile'}
              data-testid="sketch-tile"
              data-sketch-id={sketch.id}
            >
              <img src={sketch.imageDataUrl} alt={`Sketch by ${sketch.playerName}`} />
              <div className="tile-meta">
                <strong>{sketch.playerName}</strong>
                {voting ? (
                  <button
                    type="button"
                    className="btn-primary"
                    data-testid="vote-button"
                    disabled={own || alreadyVoted}
                    onClick={() => onVote(sketch.id)}
                  >
                    {own ? 'Yours' : selected ? 'Voted' : 'Vote'}
                  </button>
                ) : null}
              </div>
              <p className="voter-list" data-testid="voter-list">
                {sketch.voters.length > 0
                  ? `Votes: ${sketch.voters.join(', ')}`
                  : 'No votes yet'}
              </p>
            </article>
          );
        })}
      </div>
    </section>
  );
}
