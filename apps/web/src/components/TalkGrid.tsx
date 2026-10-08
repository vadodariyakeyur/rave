import { Crown, LoaderCircle, MicOff, UserMinus, WifiOff } from 'lucide-react';
import type { Peer } from '@rave/protocol';
import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/ui/button';
import type { PeerConnectionState } from '@/lib/mesh';
import { avatarOf } from '@/lib/cover';
import { cn } from '@/lib/utils';

/**
 * Talk mode's people: a tile each, a ring around whoever is speaking.
 *
 * The grid fills as wide as it can and tiles stay one size, so two people
 * look like a call and twenty look like a crowd. A device that cannot be
 * reached says so on its tile, because nobody else can hear them.
 */
export function TalkGrid({
  peers,
  selfPeerId,
  connections,
  speaking,
  selfMuted,
  onKick,
}: {
  peers: Peer[];
  selfPeerId: string;
  connections: ReadonlyMap<string, PeerConnectionState>;
  speaking: ReadonlySet<string>;
  selfMuted: boolean;
  onKick?: (peerId: string) => void;
}) {
  return (
    <ul className="grid animate-rise gap-4 [grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr))]">
      {peers.map((peer) => {
        const connection = connections.get(peer.peerId);
        const isSelf = peer.peerId === selfPeerId;
        const [from] = avatarOf(peer.displayName).stops;
        const tint = `oklch(${from.l} ${from.c} ${from.h})`;
        return (
          <li
            key={peer.peerId}
            data-person
            className={cn(
              'panel flex animate-pop flex-col items-center gap-3 rounded-[20px] p-5 text-center outline-2 -outline-offset-2 transition-colors',
              speaking.has(peer.peerId) ? 'outline-chart-1' : 'outline-transparent',
            )}
            style={{
              background: `radial-gradient(circle at 50% 28%, color-mix(in oklch, ${tint} 26%, transparent), transparent 62%), color-mix(in oklab, var(--color-card) 72%, transparent)`,
            }}
          >
            <Avatar name={peer.displayName} size="lg" speaking={speaking.has(peer.peerId)} />
            <div className="flex min-w-0 max-w-full flex-col items-center gap-1">
              <span className="max-w-full truncate font-bold">{peer.displayName}</span>
              <span className="flex flex-wrap items-center justify-center gap-x-2 text-xs text-muted-foreground">
                {isSelf && <span>you</span>}
                {peer.isCreator && (
                  <span className="flex items-center gap-1 text-chart-2">
                    <Crown className="size-3.5" />
                    host
                  </span>
                )}
              </span>
            </div>
            <span className="flex h-5 items-center gap-1.5 text-xs">
              {speaking.has(peer.peerId) && <span className="font-semibold text-chart-1">speaking</span>}
              {isSelf && selfMuted && (
                <span className="flex items-center gap-1 text-muted-foreground">
                  <MicOff aria-hidden className="size-3.5" />
                  muted
                </span>
              )}
              {!isSelf && connection === 'failed' && (
                <span className="flex items-center gap-1 text-destructive">
                  <WifiOff className="size-3.5" />
                  can&rsquo;t connect
                </span>
              )}
              {!isSelf && connection === 'connecting' && (
                <span className="flex items-center gap-1 text-muted-foreground">
                  <LoaderCircle className="size-3.5 animate-spin" />
                  connecting
                </span>
              )}
            </span>
            {onKick && !isSelf && (
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
          </li>
        );
      })}
    </ul>
  );
}
