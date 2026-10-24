import Link from 'next/link';
import { Backdrop } from '@/components/Backdrop';
import { buttonVariants } from '@/components/ui/button';
import { Header, Shell } from '@/components/Shell';
import { JoinCode } from '@/components/JoinCode';

export default function NotFound() {
  return (
    <Shell
      backdrop={<Backdrop title="party" calm />}
      header={<Header back="/" title="Page not found" />}
      cta={
        <Link href="/" className={buttonVariants({ size: 'lg', className: 'w-full' })}>
          Back to rooms
        </Link>
      }
    >
      <div className="flex flex-col gap-4">
        <section className="plunk block-pink mr-[3px] mb-[3px] flex animate-pop flex-col gap-3 p-5">
          <p aria-hidden className="font-display text-8xl leading-none">
            404
          </p>
          <h1 className="font-display text-4xl leading-none tracking-tight">Nothing here.</h1>
          <p className="font-semibold">That address does not lead to a page. The room may have ended.</p>
        </section>
        <JoinCode />
      </div>
    </Shell>
  );
}
