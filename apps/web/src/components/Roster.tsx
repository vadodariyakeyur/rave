import type { Peer } from '@rave/protocol';
import type { PeerConnectionState } from '@/lib/mesh';
import type { Transfer } from '@/lib/transfer';
import { Check, Crown, LoaderCircle, UserMinus, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Plain list, not a table — this is a handful of rows of name and status. */
export function Roster({
  peers,
  selfPeerId,
  connections,
  transfers,
  onKick,
}: {
  peers: Peer[];
  selfPeerId: string;
  connections: ReadonlyMap<string, PeerConnectionState>;
  /** How much of the playlist each member has been sent. The creator's view only. */
  transfers: ReadonlyMap<string, Transfer>;
  /** Present for the creator, who alone can remove someone. */
  onKick?: (peerId: string) => void;
}) {
  return (
    <ul className="divide-y divide-border">
      {peers.map((peer) => (
        <li key={peer.peerId} className="flex min-h-12 animate-pop items-center justify-between gap-3 py-2 text-sm">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-semibold">{peer.displayName}</span>
            {peer.peerId === selfPeerId && (
              <span className="text-xs text-muted-foreground">you</span>
            )}
            {peer.isCreator && (
              <span className="flex items-center gap-1 text-xs text-primary">
                <Crown className="size-3.5" />
                host
              </span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <PeerStatus
              connection={connections.get(peer.peerId)}
              transfer={transfers.get(peer.peerId)}
            />
            {onKick && peer.peerId !== selfPeerId && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove ${peer.displayName}`}
                onClick={() => onKick(peer.peerId)}
              >
                <UserMinus />
                Remove
              </Button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

const STATUS = 'flex items-center gap-1.5';

/**
 * The connection has to win when it is broken: a member shown as
 * 'downloading' who is in fact unreachable is someone the host waits for
 * forever, with nothing on screen saying why.
 */
function PeerStatus({
  connection,
  transfer,
}: {
  connection: PeerConnectionState | undefined;
  transfer: Transfer | undefined;
}) {
  // No connection at all is the ordinary case: ourselves, and — for a
  // member — every other member, who is reached only through the host.
  if (connection === undefined) return null;
  if (connection === 'failed') {
    return (
      <span className={cn(STATUS, 'text-destructive')}>
        <WifiOff className="size-4" />
        can&rsquo;t connect
      </span>
    );
  }
  if (connection !== 'connected') {
    return (
      <span className={cn(STATUS, 'text-muted-foreground')}>
        <LoaderCircle className="size-4 animate-spin" />
        connecting
      </span>
    );
  }
  // Connected, and nothing in the playlist to send them yet.
  if (!transfer) return <span className={cn(STATUS, 'text-muted-foreground')}>connected</span>;

  if (transfer.state === 'stalled') {
    return <span className={cn(STATUS, 'text-destructive')}>stalled</span>;
  }
  if (transfer.state === 'sent') {
    return (
      <span className={STATUS}>
        <Check className="size-4 animate-pop text-primary" />
        up to date
      </span>
    );
  }

  const percent = Math.round(transfer.progress * 100);
  return (
    <span
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Playlist download progress"
      className={cn(STATUS, 'tabular-nums text-muted-foreground')}
    >
      {percent}%
    </span>
  );
}
