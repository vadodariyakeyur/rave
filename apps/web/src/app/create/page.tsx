'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, LoaderCircle, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Backdrop } from '@/components/Backdrop';
import { RoomPreview } from '@/components/RoomPreview';
import { Shell, TopBar } from '@/components/Shell';
import { createRoom } from '@/lib/session';

export default function CreateRoom() {
  const router = useRouter();
  const [roomName, setRoomName] = useState('');
  const [description, setDescription] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Empty is "no passcode"; anything else has to be long enough to be one.
  const passcodeOk = passcode === '' || passcode.length >= 4;
  const ready = roomName.trim() !== '' && displayName.trim() !== '' && passcodeOk;

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || creating) return;
    setError(null);
    setCreating(true);
    try {
      // Must stay synchronous up to here: createRoom opens the AudioContext,
      // and this submit is the user gesture that lets it start.
      const room = await createRoom({
        roomName: roomName.trim(),
        description: description.trim() || undefined,
        displayName: displayName.trim(),
        passcode: passcode || undefined,
      });
      router.push(`/room/${room.snapshot().code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the room.');
      setCreating(false);
    }
  }

  return (
    <Shell backdrop={<Backdrop title={roomName.trim() || 'party'} still calm />}>
      <TopBar>
        <Link href="/" aria-label="Back to rooms" className="flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/12 hover:text-foreground">
          <ArrowLeft className="size-5" />
        </Link>
        Create a room
      </TopBar>
      <div className="grid flex-1 items-start gap-8 p-4 sm:p-8 lg:grid-cols-[27.5rem_1fr]">
      <div className="glass flex w-full max-w-110 animate-rise flex-col gap-6 rounded-[28px] p-6 text-card-foreground">
        <div className="flex flex-col gap-2">
          <h2 className="text-3xl font-bold tracking-tight">Room details</h2>
          <p className="text-muted-foreground">You add the music once you are inside.</p>
        </div>

        <form onSubmit={create} className="flex flex-col gap-5">
          <Field label="Room name" htmlFor="room-name">
            <Input
              id="room-name"
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              placeholder="Kitchen speakers"
              maxLength={64}
              autoComplete="off"
              disabled={creating}
            />
          </Field>

          <Field label="Description" htmlFor="description" hint="Optional. Shown in the room list.">
            <Input
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Friday night playlist"
              maxLength={200}
              autoComplete="off"
              disabled={creating}
            />
          </Field>

          <Field label="Your name" htmlFor="display-name">
            <Input
              id="display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Keyur"
              maxLength={32}
              autoComplete="off"
              disabled={creating}
            />
          </Field>

          <Field
            label="Passcode"
            htmlFor="passcode"
            hint={
              passcodeOk
                ? 'Optional. Leave empty and anyone can join.'
                : 'At least 4 characters, or leave it empty.'
            }
            invalid={!passcodeOk}
          >
            <Input
              id="passcode"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              maxLength={32}
              autoComplete="off"
              aria-invalid={!passcodeOk}
              disabled={creating}
            />
          </Field>

          {error && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" size="lg" disabled={!ready || creating} className="w-full">
            {creating ? <LoaderCircle className="animate-spin" /> : <Plus />}
            {creating ? 'Creating…' : 'Create room'}
          </Button>
        </form>
      </div>

      <aside aria-label="Preview" className="flex animate-rise flex-col gap-3 [animation-delay:100ms]">
        <p className="text-sm font-semibold text-muted-foreground">How it will look in the room list</p>
        <div className="max-w-110">
          <RoomPreview
            name={roomName}
            description={description.trim() || undefined}
            mode="music"
            memberCount={1}
            hasPasscode={passcode !== ''}
          />
        </div>
      </aside>
      </div>
    </Shell>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  invalid,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  invalid?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="text-sm font-semibold text-muted-foreground">
        {label}
      </label>
      {children}
      {hint && (
        <p className={`text-sm ${invalid ? 'text-destructive' : 'text-muted-foreground'}`}>{hint}</p>
      )}
    </div>
  );
}
