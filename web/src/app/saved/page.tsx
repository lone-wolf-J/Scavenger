import Link from "next/link";
import { getSaved } from "@/lib/scavenger/opportunities";

export const dynamic = "force-dynamic";

export default async function SavedPage() {
  const saved = await getSaved();
  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="font-display text-2xl tracking-tight text-landing">Saved</h1>
      <p className="mt-1 text-sm text-muted">
        Saved opportunities reference the canonical shared job — never a copy. {saved.length} total.
      </p>
      {saved.length === 0 && (
        <div className="mt-6 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center text-sm text-muted">
          Nothing saved yet. Save opportunities from the <Link href="/opportunities" className="text-brand hover:underline">Opportunities</Link> feed.
        </div>
      )}
      <div className="mt-6 space-y-3">
        {saved.map((e: {
          jobId: string; profileId: string; profileName: string; score: number | null;
          outcome: string; updatedAt: string;
          job: { title: string; company: string; location: string; url: string; lifecycle?: string } | null;
        }) => (
          <div key={`${e.profileId}::${e.jobId}`} className="rounded-2xl border border-border bg-surface/30 px-5 py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium text-foreground">{e.job?.title || e.jobId}</div>
                <div className="mt-0.5 text-xs text-muted">
                  {e.job?.company}{e.job?.location ? ` — ${e.job.location}` : ""} · {e.profileName}
                  {e.score != null ? ` · ${e.score}/100` : ""}
                </div>
              </div>
              <div className="shrink-0 text-right text-xs text-muted">
                <div className="rounded-full border border-border px-2 py-0.5">{e.outcome}</div>
                {e.job?.lifecycle && e.job.lifecycle !== "active" && (
                  <div className="mt-1 rounded-full bg-surface-hover px-2 py-0.5">{e.job.lifecycle} — kept for history</div>
                )}
                <div className="mt-1">{new Date(e.updatedAt).toLocaleDateString()}</div>
              </div>
            </div>
            {e.job?.url && (
              <a href={e.job.url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-brand hover:underline">View job</a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
