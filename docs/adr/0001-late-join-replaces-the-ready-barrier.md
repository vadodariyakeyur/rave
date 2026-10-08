# Late join replaces the ready barrier

A room used to lock when the creator pressed Play, and Play waited until every peer had the
file (the "ready barrier"), with a force-start that dropped whoever was not ready. We removed
all of it: anyone can join a room at any point, and a peer that does not yet hold the track
simply is not playing it — when it arrives they start part-way through, in sync. Rooms are
now listed on the homepage, so people will walk into rooms that are already playing, and a
room that refuses them is a dead end.

## Consequences

- A start is no longer simultaneous for everyone by construction. A slow device comes in
  late on a track rather than holding the room up.
- The server knows nothing about readiness or playback. It cannot tell whether a room is
  playing except by what the creator reports for the room list.
- The barrier metrics (wait time, force-start share) no longer exist.
