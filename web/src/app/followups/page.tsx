import { FollowupReminders } from "@/components/followups/followup-reminders";

export const dynamic = "force-dynamic";

export default function FollowupsPage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <FollowupReminders />
    </div>
  );
}
