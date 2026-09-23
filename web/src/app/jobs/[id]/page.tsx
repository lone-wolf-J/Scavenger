import { redirect } from "next/navigation";

// Worker detail pages are no longer part of the primary Scavenger experience.
// Redirect to the Jobs page.
export default function JobDetailPage() {
  redirect("/jobs");
}
