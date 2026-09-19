'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createRoom } from '@/lib/session';

export default function Home() {
  const router = useRouter();
  const [roomName, setRoomName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const ready = roomName.trim() !== '' && displayName.trim() !== '' && file !== null;

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || !file || creating) return;
    setError(null);
    setCreating(true);
    try {
      // Must stay synchronous up to here: createRoom opens the AudioContext,
      // and this submit is the user gesture that lets it start.
      const session = await createRoom({
        roomName: roomName.trim(),
        displayName: displayName.trim(),
        file,
      });
      router.push(`/room/${session.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the room.');
      setCreating(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 p-8">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">rave</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Synchronized peer-to-peer audio rooms
        </p>
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

        <Field label="Audio file" htmlFor="audio-file">
          <Input
            id="audio-file"
            type="file"
            accept="audio/*"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setError(null);
            }}
            disabled={creating}
          />
        </Field>

        {error && (
          <p role="alert" className="text-sm text-[var(--color-destructive)]">
            {error}
          </p>
        )}

        <Button type="submit" disabled={!ready || creating} className="w-full">
          {creating ? 'Decoding…' : 'Create room'}
        </Button>
      </form>
    </main>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}
