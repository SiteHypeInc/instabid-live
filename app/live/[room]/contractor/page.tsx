import { LiveRoom } from "@/components/LiveRoom";

export const dynamic = "force-dynamic";

export default function ContractorPage({ params }: { params: { room: string } }) {
  return <LiveRoom room={params.room} role="contractor" />;
}
