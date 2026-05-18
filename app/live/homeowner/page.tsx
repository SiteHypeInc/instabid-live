import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";

export default function HomeownerEntryPage({
  searchParams,
}: {
  searchParams: { room?: string };
}) {
  const slug =
    searchParams.room && /^[A-Za-z0-9_-]{4,}$/.test(searchParams.room)
      ? searchParams.room
      : randomUUID().slice(0, 8);
  redirect(`/live/${slug}/homeowner`);
}
