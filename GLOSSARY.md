# Glossary

The words this project uses, and the ones it avoids. Use these terms in code, tests, issues
and docs. For what the system is and how it fits together, see [CONTEXT.md](CONTEXT.md).

## Rooms and people

**Room**:
A live gathering of devices that play the same track together. It exists only while its creator is connected, and in memory only: a restart of the server ends every room.
_Avoid_: Session, channel, party

**Creator**:
The person who opened the room. Their device holds the tracks, issues every cue, and is the clock the others measure themselves against.
_Avoid_: Host (in code and docs; the screen says "host"), owner, admin

**Member**:
Anyone in a room other than its creator.
_Avoid_: Joiner, guest, listener, client

**Peer**:
Any one device in a room, creator or member.
_Avoid_: User, participant

**Roster**:
The server's list of the peers currently in a room. It is resent to everyone in the room whenever it changes.
_Avoid_: Member list, participants

**Room code**:
The six-character address of a room, as typed, linked to or scanned. Drawn from an alphabet with no `0`, `O`, `1`, `I` or `L`. It is not a secret.
_Avoid_: Room id, PIN

**Passcode**:
An optional secret the creator sets when opening a room, four to 32 characters; a member must present it to join. The server keeps it and never sends it back.
_Avoid_: Password, PIN, key

**Room list**:
Every live room, as shown on the homepage, with its name, description, member count, whether it has a passcode, and the title now playing. It is kept current for as long as the page is open.
_Avoid_: Lobby, directory

**Kick**:
The creator removing a member from the room. The member may join again.
_Avoid_: Ban, block

**Share link**:
The address of a room as the creator hands it out, and the content of the QR code. For a room with a passcode it carries the passcode in the fragment (`#p=…`), so whoever opens it is not asked for the passcode.
_Avoid_: Invite link

**Pre-join**:
The screen shown on a room's address before a device is in it. Its button is the tap that arms audio, then enters the room.
_Avoid_: Lobby, landing

## Playback

**Track**:
One audio file in a room's playlist.
_Avoid_: Song, file, audio

**Playlist**:
The ordered tracks the creator has added to a room, which the creator can add to, remove from and reorder. Every member holds a copy of every track, sent by the creator.
_Avoid_: Queue

**Current track**:
The track the room is on, whether or not it is playing.
_Avoid_: Selected track, active track

**Select**:
The creator naming the track the room is about to play, ahead of the cue, so every device decodes it at the same time.
_Avoid_: Preload, prepare

**Cue**:
An instruction from the creator to every peer about playback: play, pause or stop. Play and pause name an instant on the creator's clock; stop does not, because there is nothing to land on.
_Avoid_: Command, event, signal

**Late join**:
Someone entering a room that is already playing. They are sent the playlist and the cue in force, and start part-way through the track, in sync. A device that does not yet hold the track is simply not playing it until it arrives.
_Avoid_: Mid-track join

**Now playing**:
The title the creator tells the server is playing, for the room list. Display only: the server sees no playback.
_Avoid_: Status

## Timing

**Clock offset**:
How far a member's clock sits from the creator's, as measured by that member. Measured again every five seconds for as long as the room is open.
_Avoid_: Latency, lag, skew

**User offset**:
A listener's own correction for output delay their device cannot measure, such as Bluetooth. Set by a slider, within 500 ms either way, and remembered on that device across rooms.
_Avoid_: Delay, latency setting

**Drift**:
How far a device's playback has slipped from where the cue and the clock offset say it should be; positive means ahead. Checked every ten seconds while a track plays: a little is nudged out through playback rate, a lot is reseeked.
_Avoid_: Lag, desync

## Flagged ambiguities

- "Host" appears on screen for the creator. Everywhere else — code, tests, docs, issues — the term is **Creator**.
- "Signal" means the relay of connection setup (SDP and ICE) between two peers through the server. It is not a playback instruction; that is a **Cue**.
