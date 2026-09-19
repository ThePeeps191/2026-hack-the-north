> Constructed fixture. Written by hand as demo input material, not by an AI teammate.

# Sketch Night product notes

Small table game, one room (`default`), state in memory. The client is a renderer: it joins, sends actions, and paints whatever the latest room snapshot says.

The round is supposed to feel like a short party beat, not a campaign. Prompt, draw, vote, results, immediately again. Display names stay attached to sketches so the table can talk about the drawing, not an anonymous tile.

## Decided 2026-09-12

Voting is public. Players can see who voted for which sketch — it drives the banter and is part of the fun.

Public votes are part of the WebSocket payload (`sketch.voters`) and part of the gallery UI. That is current product behaviour, not a leftover.
