import { LiveRoom } from "@/components/LiveRoom";

export const dynamic = "force-dynamic";

export default function HomeownerPage({ params }: { params: { room: string } }) {
  return <LiveRoom room={params.room} role="homeowner" />;
}
