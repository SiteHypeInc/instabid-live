import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";

export default function ContractorEntryPage() {
  const slug = randomUUID().slice(0, 8);
  redirect(`/live/${slug}/contractor`);
}
