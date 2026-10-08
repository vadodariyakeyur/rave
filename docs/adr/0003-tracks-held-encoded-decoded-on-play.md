# Tracks are held encoded and decoded only when played

Every peer keeps each playlist track as the encoded file it was sent, and decodes a track
only when the room moves to it, keeping one decoded track at a time. Decoded audio is tens
of times larger than the file, the playlist is unlimited, and a phone holding a whole
playlist decoded would run out of memory.

## Consequences

- Moving to another track costs every device a decode. The creator names the track first
  (`select`) so all devices decode at once, then cues once its own decode is done; a slower
  device joins that track a moment late, in sync.
- The creator test-decodes each file when it is added and throws the result away, so a file
  that cannot be decoded never reaches a member.
