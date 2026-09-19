import type { Peer } from '@rave/protocol';
import type { PeerConnectionState } from '@/lib/mesh';

/**
 * Plain list, not a table — this is 3–8 rows of name and status.
 * Download progress joins it in #5.
 */
export function Roster({
  peers,
  selfPeerId,
  connections,
}: {
  peers: Peer[];
  selfPeerId: string;
  connections: ReadonlyMap<string, PeerConnectionState>;
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
          <PeerStatus peer={peer} self={peer.peerId === selfPeerId} connection={connections.get(peer.peerId)} />
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
}: {
  peer: Peer;
  self: boolean;
  connection: PeerConnectionState | undefined;
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
  return (
    <span className={peer.ready ? 'text-green-400' : 'text-[var(--color-muted-foreground)]'}>
      {peer.ready ? 'ready' : 'downloading'}
    </span>
  );
}
