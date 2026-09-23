import { notFound } from "next/navigation";
import Link from "next/link";
import { getWorkspace } from "@/lib/scavenger/workspace";
import { ProfileEditor } from "@/components/scavenger/profile-editor";

export const dynamic = "force-dynamic";

export default async function ProfileDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const state = await getWorkspace();
  const record = (state.profiles || []).find((p: { id: string }) => p.id === id);
  if (!record) notFound();
  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <Link href="/profiles" className="text-xs text-muted hover:text-foreground">← All profiles</Link>
      <h1 className="mt-2 font-display text-2xl tracking-tight text-landing">{record.name}</h1>
      <p className="mt-1 text-sm text-muted">
        Editing this profile never alters your other profiles.{" "}
        <Link href={`/opportunities?profiles=${record.id}`} className="text-brand hover:underline">Search with it →</Link>
      </p>
      <ProfileEditor initial={record} />
    </div>
  );
}
