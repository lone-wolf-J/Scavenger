import { ApplicationsClient } from "@/components/applications/applications-client";

export const dynamic = "force-dynamic";

export default async function ApplicationsPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <ApplicationsClient />
    </div>
  );
}
