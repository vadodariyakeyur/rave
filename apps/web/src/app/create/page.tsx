'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, LoaderCircle, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-8 px-5 py-6 sm:px-8 sm:py-8">
      <Link
        href="/"
        className="flex h-11 items-center gap-2 self-start text-sm font-semibold text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to rooms
      </Link>

      <div className="flex w-full max-w-md animate-rise flex-col gap-6 rounded-xl border-2 border-border bg-card p-6 text-card-foreground shadow-lg sm:p-8">
        <div className="flex flex-col gap-2">
          <h1 className="text-4xl font-extrabold">Create a room</h1>
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
    </main>
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
      <label htmlFor={htmlFor} className="text-sm font-semibold">
        {label}
      </label>
      {children}
      {hint && (
        <p className={`text-sm ${invalid ? 'text-destructive' : 'text-muted-foreground'}`}>{hint}</p>
      )}
    </div>
  );
}
