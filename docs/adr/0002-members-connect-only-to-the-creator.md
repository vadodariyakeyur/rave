# Members connect only to the creator

Each member opens one WebRTC connection, to the creator, instead of one to every other peer.
Tracks, clock measurement and cues all originate at the creator, so a member-to-member link
carried nothing, and rooms have no size cap, so a full mesh would grow with the square of
the room.

## Consequences

- The creator's device and uplink carry every transfer. A large room is limited by that one
  device.
- A member cannot serve a track to another member. If that is ever wanted (to take load off
  the creator), this is the decision to revisit.
- The creator leaving ends the room; there is nobody else connected to hand it to.
