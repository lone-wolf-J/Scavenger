import { Suspense } from "react";
import { ReviewFlow } from "@/components/scavenger/review-flow";

export const dynamic = "force-dynamic";

export default function ReviewPage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="font-display text-2xl tracking-tight text-landing">Here&apos;s what Scavenger understood</h1>
      <p className="mt-1 text-sm text-muted">
        Explicit statements, reasonable inferences, and unknowns are labeled. Correct anything — nothing becomes final until you confirm.
      </p>
      <Suspense fallback={<p className="mt-6 text-sm text-muted">Loading draft…</p>}>
        <ReviewFlow />
      </Suspense>
    </div>
  );
}
