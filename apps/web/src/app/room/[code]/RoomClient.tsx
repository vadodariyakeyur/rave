'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { getSession, patchSession, subscribeSession, type Session } from '@/lib/session';
import { Roster } from '@/components/Roster';
import { Mesh, type PeerConnectionState } from '@/lib/mesh';
import { Distributor, Receiver } from '@/lib/distribute';
import type { Peer } from '@rave/protocol';
import type { Transfer } from '@/lib/transfer';
import { ClockProbe, serveClock, type Estimate } from '@/lib/clock';
import {
  broadcastCue,
  DRIFT_CHECK_MS,
  listenForCues,
  Player,
  START_LEAD_MS,
  type Cue,
  type PlayerState,
} from '@/lib/player';
import { loadUserOffset, saveUserOffset } from '@/lib/offset';
import { keepAwake, onHidden } from '@/lib/wake';
import { DebugOverlay } from '@/components/DebugOverlay';
import { OffsetSlider } from '@/components/OffsetSlider';
import { Button } from '@/components/ui/button';
import { ForceStartDialog } from '@/components/ForceStartDialog';
import { PreJoin } from './PreJoin';

export function RoomClient() {
  const params = useParams<{ code: string }>();
  // The overlay is absent without the param, not hidden: it re-renders several
  // times a second and has no business existing in a normal session.
  const debug = useSearchParams()?.get('debug') === '1';
  const session = useSyncExternalStore(subscribeSession, getSession, () => undefined);

  // Keyed on the socket, not the session: patchSession replaces the session
  // object on every update, and re-subscribing each time would stack handlers.
  const signaling = session?.signaling;
  useEffect(() => {
    if (!signaling) return;
    const unsubscribeMessage = signaling.onMessage((msg) => {
      if (msg.type === 'room-state') patchSession({ state: msg });
      if (msg.type === 'room-closed') patchSession({ ended: msg.reason });
    });
    // A dropped socket leaves the roster frozen and looking live — but it is
    // our socket, not the room. Saying the host left would send someone off
    // to blame a person when the fix is their own wifi.
    const unsubscribeClose = signaling.onClose(() => {
      // The same sentence the panel shows, read from the same place: two
      // copies of this drift the moment one of them is reworded.
      toast.error(ENDED_MESSAGE['lost-connection']);
      patchSession({ ended: 'lost-connection' });
    });
    return () => {
      unsubscribeMessage();
      unsubscribeClose();
    };
  }, [signaling]);

  // The mesh outlives any single render but dies with the socket, so it is
  // created alongside the same effect that owns the socket's listeners.
  //
  // State, not a ref: the transfer effects below have to start when the mesh
  // appears, and a ref assignment renders nothing for them to start from.
  const [mesh, setMesh] = useState<Mesh | undefined>(undefined);
  const [connections, setConnections] = useState<ReadonlyMap<string, PeerConnectionState>>(
    new Map(),
  );
  const selfPeerId = session?.peerId;
  const iceServers = session?.iceServers;
  useEffect(() => {
    if (!signaling || !selfPeerId || !iceServers) return;
    const created = new Mesh({ signaling, selfPeerId, iceServers });
    // The one render this costs is the point: the transfer effects below key
    // on the mesh, and they cannot start from something they never see. It
    // fires once per socket, not per roster change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMesh(created);
    // A new Map each time: the mesh mutates its own in place, and React
    // would skip a render on an unchanged reference.
    const unsubscribe = created.subscribe(() => setConnections(new Map(created.states())));
    return () => {
      unsubscribe();
      created.close();
      setMesh(undefined);
    };
  }, [signaling, selfPeerId, iceServers]);

  // Reconcile on every roster change, including the first: the roster is the
  // server's own truth about who is in the room, so a missed event cannot
  // leave a phantom peer connected.
  const peers = session?.state.peers;
  const ended = session?.ended;
  useEffect(() => {
    if (!peers || !mesh) return;
    // A room that has ended has no peers left to hold open. Closing also stops
    // the mesh listening, which is the part that matters: 'ended' includes our
    // own socket dropping, and a later roster would otherwise sync onto a deaf
    // mesh and open connections that can never be signalled. The instance goes
    // when the socket effect unwinds; every transfer effect bails on `ended`.
    if (ended) {
      mesh.close();
      return;
    }
    mesh.sync(peers);
  }, [peers, ended, mesh]);

  // Who holds the file, and how far along. The creator watches every peer's
  // download; a joiner watches only its own. Both end up in one map because
  // the roster renders one list either way.
  const [transfers, setTransfers] = useState<ReadonlyMap<string, Transfer>>(new Map());
  const bytes = session?.bytes;
  const fileName = session?.fileName;
  const creatorId = peers?.find((p) => p.isCreator)?.peerId;
  const isCreator = selfPeerId !== undefined && selfPeerId === creatorId;

  // Keyed on the mesh instance, not on `peers`: the roster changes on every
  // join and this must not tear down a transfer in flight when it does.
  const distributorRef = useRef<Distributor | undefined>(undefined);
  useEffect(() => {
    if (!mesh || ended) return;
    if (!isCreator) return;
    if (!bytes || !fileName) return;
    const distributor = new Distributor(mesh, { bytes, fileName });
    const unsubscribe = distributor.subscribe(() =>
      setTransfers(new Map(distributor.transfers())),
    );
    distributorRef.current = distributor;
    return () => {
      unsubscribe();
      distributor.close();
      distributorRef.current = undefined;
      setTransfers(new Map());
    };
  }, [mesh, isCreator, bytes, fileName, ended]);

  // Feeding the roster in separately keeps the effect above off `peers`.
  useEffect(() => {
    if (!peers || !selfPeerId) return;
    distributorRef.current?.sync(peers.filter((p) => p.peerId !== selfPeerId).map((p) => p.peerId));
  }, [peers, selfPeerId]);

  useEffect(() => {
    if (!mesh || ended || isCreator) return;
    if (!session || !creatorId || !selfPeerId) return;
    // Already holding the file: a rejoin after the transfer landed.
    if (session.buffer) return;
    const receiver = new Receiver(mesh, creatorId, session);
    const unsubscribe = receiver.subscribe(() => {
      setTransfers(new Map([[selfPeerId, receiver.transfer()]]));
      const result = receiver.result();
      // Keep the decoded track and the bytes: #6 plays the one, and a later
      // joiner can be served from the other.
      if (result && !getSession()?.buffer) {
        patchSession({ buffer: result.buffer, fileName: result.fileName, bytes: result.bytes });
      }
    });
    receiver.start();
    return () => {
      unsubscribe();
      receiver.close();
    };
    // `session` is deliberately absent: it is replaced on every patch, and
    // depending on it would restart the download on the first progress tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mesh, isCreator, creatorId, selfPeerId, ended]);

  // The clock. The creator is the reference and only answers; every joiner
  // measures itself against them. Keyed on the mesh like the transfers above,
  // so a roster change does not restart a round mid-flight.
  useEffect(() => {
    if (!mesh || ended || !isCreator) return;
    // A channel opens after its peer is already in the roster, so this
    // re-runs on every mesh notify and attaches to whatever is newly open.
    const served = new Map<string, () => void>();
    const attach = () => {
      for (const [peerId] of mesh.states()) {
        if (served.has(peerId)) continue;
        const channel = mesh.channel(peerId);
        if (!channel) continue;
        served.set(peerId, serveClock(channel));
      }
    };
    attach();
    const unsubscribe = mesh.subscribe(attach);
    return () => {
      unsubscribe();
      for (const stop of served.values()) stop();
    };
  }, [mesh, isCreator, ended]);

  // Who was here last render. A ref, not state: it exists to be diffed
  // against, and writing it must not itself cause a render.
  const knownPeers = useRef<ReadonlySet<string> | undefined>(undefined);
  useEffect(() => {
    if (!peers) return;
    const now = new Set(peers.map((p) => p.peerId));
    const before = knownPeers.current;
    knownPeers.current = now;
    // The first roster is everyone already here, including ourselves. Nobody
    // "joined" — announcing four arrivals on entry is noise, not news.
    if (!before) return;
    for (const peer of peers) {
      if (!before.has(peer.peerId)) toast(`${peer.displayName} joined`);
    }
  }, [peers]);

  // Stalled is a transition, not a state: the roster already shows the badge
  // for as long as it lasts, so a toast per render would be a stream of them.
  const stalled = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const now = new Set(
      [...transfers].filter(([, t]) => t.state === 'stalled').map(([peerId]) => peerId),
    );
    for (const peerId of now) {
      if (stalled.current.has(peerId)) continue;
      // Both sides mark stalled, but a joiner's map holds only itself — being
      // told "Ada has stopped downloading" when you are Ada is nonsense. The
      // creator is the one who has to decide whether to wait.
      if (peerId === selfPeerId) continue;
      const name = peers?.find((p) => p.peerId === peerId)?.displayName ?? 'A peer';
      toast.warning(`${name} has stopped downloading.`);
    }
    stalled.current = now;
  }, [transfers, peers, selfPeerId]);

  // The roster at the moment the dialog opened, not at the moment it renders.
  // A peer going ready (or stalling) while the creator reads the dialog would
  // otherwise rewrite the list under them — and the dangerous direction is
  // silent: a peer who stalls after it opens is never named, then dropped.
  const [confirming, setConfirming] = useState<readonly Peer[] | undefined>(undefined);

  const [estimate, setEstimate] = useState<Estimate | undefined>(undefined);
  useEffect(() => {
    if (!mesh || ended || isCreator || !creatorId) return;
    let probe: ClockProbe | undefined;
    const attach = () => {
      if (probe) return;
      const channel = mesh.channel(creatorId);
      if (!channel) return;
      probe = new ClockProbe(channel);
      probe.subscribe(() => setEstimate(probe?.estimate()));
      probe.start();
    };
    attach();
    const unsubscribe = mesh.subscribe(attach);
    return () => {
      unsubscribe();
      probe?.close();
      setEstimate(undefined);
    };
  }, [mesh, isCreator, creatorId, ended]);

  // Playback. One Player per device, driven by cues on the creator's clock —
  // including on the creator itself, which is simply the peer whose offset is
  // zero. Two paths here would be two chances to schedule differently.
  const audioContext = session?.audioContext;
  const buffer = session?.buffer;
  // Derived, not held in a ref: the auto-start effect below has to fire when
  // the player appears, and a ref cannot be a dependency.
  //
  // Gone when the room ends, not just when the audio does: once the creator
  // is gone there is no shared clock, so a track still running is a track
  // drifting alone behind a banner saying the room is over.
  const player = useMemo(
    () => (audioContext && buffer && !ended ? new Player({ sink: audioContext, buffer }) : undefined),
    [audioContext, buffer, ended],
  );
  const [playback, setPlayback] = useState<PlayerState>({
    playing: false,
    positionSeconds: 0,
  });
  useEffect(() => {
    if (!player) return;
    const unsubscribe = player.subscribe(() => setPlayback(player.state()));
    return () => {
      unsubscribe();
      player.close();
    };
  }, [player]);

  // The audio clock and the monotonic clock diverge on their own, so a track
  // that started in sync does not stay there. Correcting is a rate nudge
  // until the gap is too wide to nudge, then a reseek.
  //
  // Slowly on purpose: drift accumulates over minutes, and correcting on a
  // short cadence chases measurement jitter instead.
  useEffect(() => {
    if (!player) return;
    const timer = setInterval(() => player.correct(), DRIFT_CHECK_MS);
    return () => clearInterval(timer);
  }, [player]);

  // Read far faster than it is corrected, and only with the overlay open.
  // Sampling on the correction cadence would show the drift exactly when it
  // is smallest — a number that never moves, hiding the excursion between
  // the corrections, which is the one thing the overlay exists to show.
  const [driftMs, setDriftMs] = useState(0);
  useEffect(() => {
    if (!player || !debug) return;
    const timer = setInterval(() => setDriftMs(player.drift()), 250);
    return () => clearInterval(timer);
  }, [player, debug]);

  // Lazily, because localStorage is not there during the server render.
  const [userOffsetMs, setUserOffsetMs] = useState(() => loadUserOffset());
  // The stored value has to reach a player that appears after it was read.
  useEffect(() => {
    player?.setUserOffset(userOffsetMs);
  }, [player, userOffsetMs]);
  const changeUserOffset = useCallback((value: number) => {
    setUserOffsetMs(value);
    saveUserOffset(value);
  }, []);

  /**
   * Cue every peer, and ourselves, off one instant on our own clock.
   *
   * The creator is the reference, so the instant it sends is already in the
   * clock every peer measured itself against — no conversion here, all of it
   * on the receiving side. One path for the first play and for every pause
   * and resume after it: a second spelling is a second way to drift.
   */
  const cue = useCallback(
    (make: (at: number) => Cue) => {
      const at = performance.now() + START_LEAD_MS;
      const message = make(at);
      if (mesh) {
        broadcastCue(
          mesh,
          (peers ?? []).filter((p) => p.peerId !== selfPeerId).map((p) => p.peerId),
          message,
        );
      }
      player?.apply(message, 0);
    },
    [mesh, peers, selfPeerId, player],
  );

  // The measured offset, read at cue time rather than depended on: it
  // re-measures every few seconds, and restarting this effect on each round
  // would tear down the listener mid-track.
  const offsetRef = useRef(0);
  useEffect(() => {
    if (estimate?.offsetMs !== undefined) offsetRef.current = estimate.offsetMs;
  }, [estimate]);

  // A joiner listens; the creator has nobody to listen to.
  useEffect(() => {
    if (!mesh || ended || isCreator || !creatorId) return;
    return listenForCues(mesh, creatorId, (cue) => player?.apply(cue, offsetRef.current));
  }, [mesh, isCreator, creatorId, ended, player]);

  // The first cue fires when the server confirms the lock, not when the
  // button is tapped: the lock is what settles who is actually in the room,
  // and a cue sent a moment earlier would name peers about to be excluded.
  //
  // Once only. The roster changes after the lock too — an excluded peer
  // leaving is a roster change — and recueing then would restart the track
  // from the top for everyone still listening.
  const locked = session?.state.locked ?? false;
  const started = useRef(false);
  useEffect(() => {
    if (!isCreator || !locked || !player || started.current) return;
    started.current = true;
    cue((at) => ({ type: 'play', startAt: at, fromSeconds: 0 }));
  }, [isCreator, locked, player, cue]);

  // The creator keeps the room alive by staying visible. Neither of these
  // prevents a backgrounded tab — they make it visible and less likely.
  useEffect(() => {
    if (!isCreator || ended) return;
    const release = keepAwake();
    const stop = onHidden(() =>
      toast.warning('Keep this tab open — this device is the clock for the room.'),
    );
    return () => {
      release();
      stop();
    };
  }, [isCreator, ended]);

  // No session means a refresh or a pasted link — the tap that arms audio has
  // not happened, so this is where it happens.
  const code = params?.code?.toUpperCase();
  if (!session) return code ? <PreJoin code={code} /> : null;

  const { state } = session;
  // The server's flag, not our own view of it: a peer we cannot see is still
  // in the room, and the barrier is the whole room's business. An empty room
  // is not "everyone ready" — every() says true for nobody, and a creator
  // alone would get a lit button with no one to play to.
  const everyoneReady = state.peers.length > 1 && state.peers.every((p) => p.ready);
  // Named, not counted: "2 peers" tells the creator nothing about whether to
  // wait, and the whole point of the dialog is that they recognise the device.
  const notReady = state.peers.filter((p) => !p.ready);
  const start = (force: boolean) => session.signaling.send({ type: 'start-playback', force });

  const play = () =>
    cue((at) => ({
      type: 'play',
      startAt: at,
      // Zero on a first play; where we paused on a resume.
      fromSeconds: player?.position() ?? 0,
    }));
  const pause = () => cue((at) => ({ type: 'pause', pauseAt: at }));

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-8 p-8">
      {debug && (
        <DebugOverlay
          estimate={estimate}
          driftMs={driftMs}
          connections={connections}
          selfPeerId={session.peerId}
          isCreator={isCreator}
        />
      )}
      <header className="flex flex-col gap-1">
        <p className="text-sm text-[var(--color-muted-foreground)]">{state.roomName}</p>
        <h1 className="font-mono text-4xl font-semibold tracking-[0.2em]">{state.code}</h1>
        {session.fileName && session.buffer && (
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {session.fileName} · {formatDuration(session.buffer.duration)}
          </p>
        )}
      </header>

      {session.ended ? (
        // The roster behind this has no socket keeping it true, so it goes
        // rather than sitting there looking live next to the bad news.
        <p
          role="alert"
          className="rounded-md border border-[var(--color-destructive)] p-3 text-sm text-[var(--color-destructive)]"
        >
          {ENDED_MESSAGE[session.ended]}
        </p>
      ) : (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-[var(--color-muted-foreground)]">
            In the room
          </h2>
          <Roster
            peers={state.peers}
            selfPeerId={session.peerId}
            connections={connections}
            transfers={transfers}
          />
          <OffsetSlider valueMs={userOffsetMs} onChange={changeUserOffset} />
          {isCreator && (
            <>
              <Button
                type="button"
                // Alone in the room there is nobody to play to; with someone
                // stuck the button still works, it just asks first. Once the
                // room is locked the same button runs the track — the server
                // has already had its say, and the rest is cues on the wire.
                disabled={state.peers.length < 2}
                onClick={() => {
                  if (state.locked) return playback.playing ? pause() : play();
                  if (everyoneReady) return start(false);
                  setConfirming(notReady);
                }}
              >
                {!state.locked ? 'Play' : playback.playing ? 'Pause' : 'Resume'}
              </Button>
              {state.locked ? (
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  Started. The room is closed to new joins.
                </p>
              ) : (
                !everyoneReady &&
                state.peers.length > 1 && (
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    Waiting for everyone to finish downloading.
                  </p>
                )
              )}
              <ForceStartDialog
                notReady={confirming}
                onCancel={() => setConfirming(undefined)}
                onConfirm={() => {
                  setConfirming(undefined);
                  start(true);
                }}
              />
            </>
          )}
        </section>
      )}
    </main>
  );
}

const ENDED_MESSAGE: Record<NonNullable<Session['ended']>, string> = {
  'creator-left': 'This room has ended. The person who created it left.',
  'room-empty': 'This room has ended. Everyone else left.',
  'lost-connection': 'Lost the connection to this room. Check the network and rejoin.',
  excluded: 'The room started without you. Your download had not finished in time.',
};

function formatDuration(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
