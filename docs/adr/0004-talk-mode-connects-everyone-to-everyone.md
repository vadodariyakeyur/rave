# Talk mode connects everyone to everyone

In talk mode every device opens a connection to every other device in the room, and each
sends its voice straight to the rest. This departs from [ADR 0002](0002-members-connect-only-to-the-creator.md),
which held because everything in music mode originates at the creator. Voice does not: any
member may speak, and everyone must hear everyone. Routing it through the creator would put
every voice through one phone twice, and would need that phone to mix a separate stream for
each member.

Music mode keeps the star. The mode is the creator's choice and lives on the server, which
sends it in the roster, so a device decides who to connect to from the roster alone.

## Consequences

- Each device uploads one stream per other person. This is fine for a handful and degrades
  past about 8; rooms have no cap, so the screen warns and does not refuse.
- Every connection carries an audio line from the start, silent until a microphone is put on
  it, so turning a microphone on or off never renegotiates.
- Switching to talk stops the music for everyone. The playlist and the files already sent are
  kept, so switching back is immediate. Switching back drops the member-to-member connections.
- Without a TURN server, people on strict networks may be unable to reach each other. On one
  wifi network this does not matter.
- A server that mixes, or an SFU, is what a large room would really need. That is a different
  system and is not built.
