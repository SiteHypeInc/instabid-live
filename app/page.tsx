import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-8 px-6 py-12 text-center">
      <div className="flex flex-col items-center gap-3">
        <span className="rounded-full bg-bid/15 px-3 py-1 text-xs font-medium uppercase tracking-widest text-bid">
          InstaBid
        </span>
        <h1 className="text-4xl font-semibold tracking-tight">InstaBid Live</h1>
        <p className="text-sm text-white/70">
          Walk the job. Get the bid before you reach your truck.
        </p>
      </div>

      <div className="w-full rounded-2xl border border-line bg-slab/60 p-5 text-left text-sm leading-relaxed text-white/70">
        <p className="font-medium text-white">How it works</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>Contractor opens the contractor link on their phone.</li>
          <li>Homeowner opens the homeowner link on theirs.</li>
          <li>Walk the room together. The AI estimator listens.</li>
          <li>Itemized estimate lands in the homeowner&apos;s inbox.</li>
        </ol>
      </div>

      <div className="flex w-full flex-col gap-2 text-xs text-white/50">
        <p>
          To start a session, open a link of the form{" "}
          <code className="rounded bg-slab px-1.5 py-0.5 text-white/80">
            /live/&lt;room-id&gt;/contractor
          </code>{" "}
          or{" "}
          <code className="rounded bg-slab px-1.5 py-0.5 text-white/80">
            /live/&lt;room-id&gt;/homeowner
          </code>
          .
        </p>
        <p>
          Demo:{" "}
          <Link href="/live/demo-room/contractor" className="text-bid hover:underline">
            contractor view
          </Link>
          {" · "}
          <Link href="/live/demo-room/homeowner" className="text-bid hover:underline">
            homeowner view
          </Link>
        </p>
      </div>
    </main>
  );
}
