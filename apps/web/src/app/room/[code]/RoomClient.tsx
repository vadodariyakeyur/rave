'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { getSession, patchSession, subscribeSession, type Session } from '@/lib/session';
import { Roster } from '@/components/Roster';
import { Mesh, type PeerConnectionState } from '@/lib/mesh';
import { Distributor, Receiver } from '@/lib/distribute';
import type { Transfer } from '@/lib/transfer';
import { ClockProbe, serveClock, type Estimate } from '@/lib/clock';
import { DebugOverlay } from '@/components/DebugOverlay';
import { Button } from '@/components/ui/button';
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
    const unsubscribeClose = signaling.onClose(() => patchSession({ ended: 'lost-connection' }));
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

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-8 p-8">
      {debug && (
        <DebugOverlay
          estimate={estimate}
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
          {isCreator && (
            <>
              <Button
                type="button"
                disabled={!everyoneReady}
                // #6 schedules the actual start; the barrier is what #5 owes it.
                onClick={() => undefined}
              >
                Play
              </Button>
              {!everyoneReady && (
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  Waiting for everyone to finish downloading.
                </p>
              )}
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
};

function formatDuration(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
