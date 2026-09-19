type LobbyProps = {
  joined: boolean;
  name: string;
  onNameChange: (value: string) => void;
  onJoin: () => void;
  onStart: () => void;
  canStart: boolean;
  playerCount: number;
};

export function Lobby({
  joined,
  name,
  onNameChange,
  onJoin,
  onStart,
  canStart,
  playerCount,
}: LobbyProps) {
  return (
    <section className="panel lobby">
      <h2>Lobby</h2>
      <p className="lede">
        Join room <code>default</code> and wait for the table to fill. Anyone can start the round.
      </p>
      {!joined ? (
        <form
          className="join-form"
          onSubmit={(event) => {
            event.preventDefault();
            onJoin();
          }}
        >
          <label htmlFor="join-name-input">Display name</label>
          <input
            id="join-name-input"
            data-testid="join-name-input"
            autoComplete="nickname"
            maxLength={24}
            placeholder="Ada"
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
          />
          <button type="submit" className="btn-primary" data-testid="join-button">
            Join room
          </button>
        </form>
      ) : (
        <div className="lobby-ready">
          <p>
            {playerCount === 1
              ? 'You are in the room. Start when you are ready.'
              : `${playerCount} players in the room.`}
          </p>
          <button
            type="button"
            className="btn-primary"
            onClick={onStart}
            disabled={!canStart}
          >
            Start round
          </button>
        </div>
      )}
    </section>
  );
}
