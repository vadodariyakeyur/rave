import type { Peer } from '@rave/protocol';
import type { PeerConnectionState } from '@/lib/mesh';
import type { Transfer } from '@/lib/transfer';
import { Check, Crown, LoaderCircle, Mic, MicOff, UserMinus, WifiOff } from 'lucide-react';
import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** The people, host first, as Discord groups them: a handful of rows of name and status. */
export function Roster({
  peers,
  selfPeerId,
  connections,
  transfers,
  speaking,
  selfMuted = false,
  onKick,
}: {
  peers: Peer[];
  selfPeerId: string;
  connections: ReadonlyMap<string, PeerConnectionState>;
  /** How much of the playlist each member has been sent. The creator's view only. */
  transfers: ReadonlyMap<string, Transfer>;
  /** Talk mode only: who is speaking right now. Absent in music. */
  speaking?: ReadonlySet<string>;
  /** Talk mode only: this device's microphone is on and muted. */
  selfMuted?: boolean;
  /** Present for the creator, who alone can remove someone. */
  onKick?: (peerId: string) => void;
}) {
  const groups = [
    { title: 'Host', people: peers.filter((p) => p.isCreator) },
    { title: 'Members', people: peers.filter((p) => !p.isCreator) },
  ].filter((g) => g.people.length > 0);
  return (
    <div className="flex flex-col gap-4">
      {groups.map(({ title, people }) => (
        <section key={title} aria-label={title} className="flex flex-col gap-0.5">
          <h3 className="px-2 pb-1 text-sm font-semibold text-muted-foreground">
            {title} &mdash; {people.length}
          </h3>
          <ul className="flex flex-col gap-0.5">
            {people.map((peer) => (
              <li
                key={peer.peerId}
                data-person
                className="group flex min-h-12 animate-pop items-center gap-2.5 rounded-2xl px-2 py-1.5 text-sm hover:bg-white/8"
              >
                <span className="relative shrink-0">
                  <Avatar name={peer.displayName} size="sm" speaking={speaking?.has(peer.peerId)} />
                  <span
                    aria-hidden
                    className="absolute -right-0.5 -bottom-0.5 size-3.5 rounded-full border-[3px] border-card bg-chart-1"
                  />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium">{peer.displayName}</span>
                    {peer.peerId === selfPeerId && <span className="text-xs text-muted-foreground">you</span>}
                    {peer.isCreator && <Crown aria-label="host" className="size-3.5 shrink-0 text-chart-2" />}
                    {speaking?.has(peer.peerId) && (
                      <Mic aria-label="speaking" className="size-3.5 shrink-0 animate-pulse text-chart-1" />
                    )}
                    {peer.peerId === selfPeerId && selfMuted && (
                      <MicOff aria-label="muted" className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                  </span>
                  <PeerStatus
                    connection={connections.get(peer.peerId)}
                    transfer={transfers.get(peer.peerId)}
                  />
                </span>
                {onKick && peer.peerId !== selfPeerId && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 hover:text-destructive md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                    aria-label={`Remove ${peer.displayName}`}
                    onClick={() => onKick(peer.peerId)}
                  >
                    <UserMinus />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const STATUS = 'flex items-center gap-1.5 text-xs';

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
        <WifiOff className="size-3.5" />
        can&rsquo;t connect
      </span>
    );
  }
  if (connection !== 'connected') {
    return (
      <span className={cn(STATUS, 'text-muted-foreground')}>
        <LoaderCircle className="size-3.5 animate-spin" />
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
        <Check className="size-3.5 animate-pop text-chart-1" />
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
