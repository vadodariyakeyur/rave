import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Backdrop } from '@/components/Backdrop';
import { buttonVariants } from '@/components/ui/button';
import { Shell, TopBar } from '@/components/Shell';

export default function NotFound() {
  return (
    <Shell backdrop={<Backdrop title="party" still calm />}>
      <TopBar>Page not found</TopBar>
      <section className="flex flex-col items-start gap-4 p-4 sm:p-8">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Nothing here.</h1>
        <p className="text-muted-foreground">That address does not lead to a page. The room may have ended.</p>
        <Link href="/" className={buttonVariants()}>
          <ArrowLeft />
          Back to rooms
        </Link>
      </section>
    </Shell>
  );
}
