import type { Peer } from '@rave/protocol';
import type { PeerConnectionState } from '@/lib/mesh';
import type { Transfer } from '@/lib/transfer';

/** Plain list, not a table — this is 3–8 rows of name, progress and status. */
export function Roster({
  peers,
  selfPeerId,
  connections,
  transfers,
}: {
  peers: Peer[];
  selfPeerId: string;
  connections: ReadonlyMap<string, PeerConnectionState>;
  /** Live download state per peer id, from whichever side is watching it. */
  transfers: ReadonlyMap<string, Transfer>;
}) {
  return (
    <ul className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)] bg-[var(--color-card)]">
      {peers.map((peer) => (
        <li key={peer.peerId} className="flex items-center justify-between gap-4 p-3 text-sm">
          <span className="truncate">
            {peer.displayName}
            {peer.peerId === selfPeerId && (
              <span className="ml-2 text-xs text-[var(--color-muted-foreground)]">you</span>
            )}
            {peer.isCreator && (
              <span className="ml-2 text-xs text-[var(--color-muted-foreground)]">host</span>
            )}
          </span>
          <PeerStatus
            peer={peer}
            self={peer.peerId === selfPeerId}
            connection={connections.get(peer.peerId)}
            transfer={transfers.get(peer.peerId)}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * The connection has to win over readiness when it is broken: a peer shown
 * as 'downloading' who is in fact unreachable is someone the host waits for
 * forever, with nothing on screen saying why.
 */
function PeerStatus({
  peer,
  self,
  connection,
  transfer,
}: {
  peer: Peer;
  self: boolean;
  connection: PeerConnectionState | undefined;
  transfer: Transfer | undefined;
}) {
  // There is no connection to ourselves, and none to report.
  if (!self) {
    if (connection === 'failed') {
      return <span className="text-[var(--color-destructive)]">can&rsquo;t connect</span>;
    }
    if (connection !== 'connected') {
      return <span className="text-[var(--color-muted-foreground)]">connecting</span>;
    }
  }
  // The server's own flag wins once it is set: it is what the barrier reads,
  // so a roster disagreeing with the Play button would be the confusing one.
  if (peer.ready) return <span className="text-green-400">ready</span>;

  if (transfer?.state === 'stalled') {
    return <span className="text-[var(--color-destructive)]">stalled</span>;
  }

  // Everything is on the wire, and the peer has not said it landed. Distinct
  // from ready on purpose: the creator should see that they are waiting on a
  // device, not on their own upload.
  if (transfer?.state === 'sent') {
    return <span className="text-[var(--color-muted-foreground)]">decoding</span>;
  }

  // No transfer yet means the channel has not opened; there is nothing to
  // show a percentage of, so say what is actually happening.
  if (!transfer) return <span className="text-[var(--color-muted-foreground)]">waiting</span>;

  // Rounded once: the bar, the label and the number must agree, and three
  // separate roundings of a moving value is three chances they do not.
  const percent = Math.round(transfer.progress * 100);

  return (
    <span className="flex items-center gap-2 text-[var(--color-muted-foreground)]">
      <span
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${peer.displayName} download progress`}
        className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--color-muted)]"
      >
        <span
          className="block h-full bg-[var(--color-primary)] transition-[width] duration-200"
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="tabular-nums">{percent}%</span>
    </span>
  );
}
