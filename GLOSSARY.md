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

## Modes

**Mode**:
What a room is doing: music or talk. The creator switches it at any time, and the server tells everyone through the roster, so a device that joins later learns it the same way.
_Avoid_: Type, kind, channel

**Music mode**:
Every device plays the creator's tracks at the same instant. Members connect only to the creator.
_Avoid_: Listen mode, playback mode

**Talk mode**:
Everyone in the room can speak to everyone else, like a group voice call. Every device connects to every other. Switching to it stops the music; the playlist is kept.
_Avoid_: Voice chat, call, voice mode

**Mute**:
A device's microphone stays on but sends silence. Letting go of the microphone entirely happens only on leaving talk mode.
_Avoid_: Hold, disable

## On screen

**Stage**:
Music mode's main tile: the current track's cover with a ring of bars that move with the sound, its title, how far through it is, and the creator's controls. The room around it is lit by the **Backdrop**; the tile itself is a plain surface, not **Glass**.
_Avoid_: Player, now-playing card

**Cover**:
A track's picture: the one inside its file when it has one (MP3, M4A or FLAC), otherwise one generated from its title, so the same title looks the same on every device. A room's card gets a cover generated from its name.
_Avoid_: Artwork, thumbnail, album art (in code; they are fine in prose)

**Glass**:
The translucent layer used for navigation and controls: the sidebar, the bars, the player capsule, dialogs. It blurs what is behind it and is never used for content, which is a plain tinted surface; glass does not sit on glass. An approximation of Apple's Liquid Glass, not the material itself.
_Avoid_: Frosted, blur (in the UI)

**Backdrop**:
The blurred, slowly turning colour behind the whole window, made from four copies of the current cover (or, with none, the room's own). The glass panels sit on it. It crossfades when the track changes and holds still when nothing is playing or the system asks for less motion.
_Avoid_: Background, wallpaper

**Visuals**:
The moving ring of bars around the cover. Drawn on each device from the audio it is playing, so it stays in step without anything being sent. A person can switch it off, and it starts off for anyone who asked their system for less motion.
_Avoid_: Visualizer (in the UI)

**Reaction**:
A tap on one of five icons (heart, fire, thumbs-up, party, laugh) that floats up on everyone's screen in the room. One of a fixed few, never text, and limited to five a second per person.
_Avoid_: Emoji, like

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
