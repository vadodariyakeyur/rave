'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LoaderCircle, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Backdrop } from '@/components/Backdrop';
import { RoomPreview } from '@/components/RoomPreview';
import { Header, Shell } from '@/components/Shell';
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
    <Shell
      backdrop={<Backdrop title="party" calm />}
      header={<Header back="/" title="Create a room" />}
      cta={
        <Button type="submit" form="create-form" size="lg" disabled={!ready || creating} className="w-full">
          {creating ? <LoaderCircle className="animate-spin" /> : <Plus />}
          {creating ? 'Creating…' : 'Create room'}
        </Button>
      }
      aside={
        <>
          <section className="plunk block-yellow mr-[3px] mb-[3px] flex animate-rise flex-col gap-2 p-5">
            <h1 className="font-display text-[2rem] leading-[0.95] tracking-tight lg:text-[2.75rem]">
              Name it. Share it. Play it.
            </h1>
            <p className="font-semibold">You add the music once you are inside.</p>
          </section>

          <section aria-label="Preview">
            <RoomPreview
              name={roomName}
              description={description.trim() || undefined}
              mode="music"
              still
              memberCount={1}
              hasPasscode={passcode !== ''}
            />
          </section>
        </>
      }
    >
      <form id="create-form" onSubmit={create} className="grid gap-3 lg:grid-cols-2">
        <Field step="01" label="Room name" htmlFor="room-name">
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

        <Field step="02" label="Description" htmlFor="description" hint="Optional. Shown in the room list.">
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

        <Field step="03" label="Your name" htmlFor="display-name">
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
          step="04"
          label="Passcode"
          htmlFor="passcode"
          hint={passcodeOk ? 'Optional. Leave empty and anyone can join.' : 'At least 4 characters, or leave it empty.'}
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
          <p role="alert" className="text-sm lg:col-span-2 font-medium text-destructive">
            {error}
          </p>
        )}
      </form>
    </Shell>
  );
}

function Field({
  step,
  label,
  htmlFor,
  hint,
  invalid,
  children,
}: {
  step: string;
  label: string;
  htmlFor: string;
  hint?: string;
  invalid?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flat flex items-start gap-4 p-4 focus-within:border-ring">
      <span
        aria-hidden
        className="font-display text-4xl leading-none text-transparent [-webkit-text-stroke:1px_var(--color-ring)]"
      >
        {step}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <label htmlFor={htmlFor} className="text-[0.8125rem] font-extrabold tracking-wide text-ring uppercase">
          {label}
        </label>
        {children}
        {hint && <p className={`text-sm ${invalid ? 'text-destructive' : 'text-muted-foreground'}`}>{hint}</p>}
      </div>
    </div>
  );
}
