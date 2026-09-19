import type { Peer } from '@rave/protocol';

/**
 * Plain list, not a table — this is 3–8 rows of name and status.
 * Download progress joins it in #5.
 */
export function Roster({ peers, selfPeerId }: { peers: Peer[]; selfPeerId: string }) {
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
          <span className={peer.ready ? 'text-green-400' : 'text-[var(--color-muted-foreground)]'}>
            {peer.ready ? 'ready' : 'downloading'}
          </span>
        </li>
      ))}
    </ul>
  );
}
