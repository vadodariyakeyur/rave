'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@rave/protocol';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** Join a room from its code: the alphabet and length come from the protocol, so a typo is caught here. */
export function JoinCode() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const ready = code.length === ROOM_CODE_LENGTH;

  return (
    <form
      className="flat flex flex-col gap-2 p-4 focus-within:border-ring"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) router.push(`/room/${code}`);
      }}
    >
      <label htmlFor="join-code" className="text-[0.8125rem] font-extrabold tracking-wide text-ring uppercase">
        Join with a code
      </label>
      <div className="flex gap-2">
        <Input
          id="join-code"
          value={code}
          onChange={(e) =>
            setCode(
              [...e.target.value.toUpperCase()]
                .filter((c) => ROOM_CODE_ALPHABET.includes(c))
                .join('')
                .slice(0, ROOM_CODE_LENGTH),
            )
          }
          placeholder="ABC234"
          maxLength={ROOM_CODE_LENGTH}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="font-mono tracking-[0.3em] uppercase"
        />
        <Button type="submit" disabled={!ready} aria-label="Join room">
          <ArrowRight />
        </Button>
      </div>
    </form>
  );
}
