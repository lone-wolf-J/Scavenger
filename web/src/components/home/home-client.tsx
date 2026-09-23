"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Upload, Plus, Search, Loader2, MapPin, Building2, Clock, Banknote } from "lucide-react";
import { inter } from "@/lib/fonts";
import { HeroGlow } from "@/components/hero-glow";

type Profile = { id: string; name: string; profile: Record<string, unknown> };

const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function HomeClient({ profiles }: { profiles: Profile[] }) {
  const router = useRouter();
  const [selectedProfile, setSelectedProfile] = useState<string>(profiles[0]?.id || "");
  const [searching, setSearching] = useState(false);
  const [targetRoles, setTargetRoles] = useState("");
  const [location, setLocation] = useState("");
  const [workplace, setWorkplace] = useState("");
  const [employment, setEmployment] = useState("");

  const activeProfile = profiles.find((p) => p.id === selectedProfile);
  const prof = activeProfile?.profile || {};
  const inferredRoles = strList(prof.targetRoles).slice(0, 3);

  async function handleSearch() {
    if (!selectedProfile) return;
    setSearching(true);
    // Store search prefs in session for the jobs page to pick up
    sessionStorage.setItem("scavenger:searchPrefs", JSON.stringify({
      profileIds: [selectedProfile],
      targetRoles: targetRoles || undefined,
      location: location || undefined,
      workplace: workplace || undefined,
      employment: employment || undefined,
    }));
    router.push("/jobs?discover=1");
  }

  if (profiles.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10 md:py-16">
        <section className="dot-bg relative overflow-hidden rounded-2xl border border-border bg-surface/40 px-7 py-10 md:px-10 md:py-12">
          <HeroGlow />
          <div aria-hidden className="pointer-events-none absolute inset-0 z-[1] bg-surface/55 backdrop-blur-[2px] dark:bg-background/45" />
          <div className="relative z-10">
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
              <span className="text-faint">//</span> get started
            </p>
            <h1 className={`${inter.className} mt-3 text-4xl leading-[1.05] text-landing md:text-5xl`}>
              Find your next opportunity.
            </h1>
            <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-muted">
              Upload your resume and Scavenger will build your professional profile, then search jobs across multiple sources.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link href="/profiles" className="orchid-cta inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium transition max-sm:min-h-[44px]">
                <Upload className="size-4" /> Upload Resume
              </Link>
              <Link href="/profiles" className="inline-flex items-center gap-2 rounded-full border border-border px-5 py-2.5 text-sm font-medium text-foreground transition hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]">
                <Plus className="size-4" /> Create Profile Manually
              </Link>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <section className="dot-bg relative overflow-hidden rounded-2xl border border-border bg-surface/40 px-7 py-10 md:px-10 md:py-12">
        <HeroGlow />
        <div aria-hidden className="pointer-events-none absolute inset-0 z-[1] bg-surface/55 backdrop-blur-[2px] dark:bg-background/45" />
        <div className="relative z-10">
          <h1 className={`${inter.className} text-3xl leading-[1.1] text-landing md:text-4xl`}>
            Find your next opportunity.
          </h1>

          <div className="mt-6 space-y-4">
            <div>
              <label className="text-xs font-medium uppercase tracking-wide text-muted">Profile</label>
              <select
                value={selectedProfile}
                onChange={(e) => setSelectedProfile(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              {activeProfile && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {inferredRoles.map((r) => (
                    <span key={r} className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">{r}</span>
                  ))}
                  {typeof prof.seniority === "string" && prof.seniority && (
                    <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">{prof.seniority}</span>
                  )}
                </div>
              )}
            </div>

            <div>
              <label className="text-xs font-medium uppercase tracking-wide text-muted">What are you looking for?</label>
              <div className="mt-1.5 space-y-2">
                <div className="relative">
                  <Building2 className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
                  <input
                    value={targetRoles}
                    onChange={(e) => setTargetRoles(e.target.value)}
                    placeholder={inferredRoles.length ? `e.g. ${inferredRoles.join(", ")}` : "Target roles, comma-separated"}
                    className="w-full rounded-md border border-border bg-surface pl-9 pr-3 py-2 text-sm"
                  />
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <div className="relative">
                    <MapPin className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
                    <input
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      placeholder="Location (e.g. United States)"
                      className="w-full rounded-md border border-border bg-surface pl-9 pr-3 py-2 text-sm"
                    />
                  </div>
                  <select value={workplace} onChange={(e) => setWorkplace(e.target.value)}
                    className="rounded-md border border-border bg-surface px-3 py-2 text-sm">
                    <option value="">Workplace</option>
                    <option value="Remote">Remote</option>
                    <option value="Hybrid">Hybrid</option>
                    <option value="On-site">On-site</option>
                  </select>
                  <select value={employment} onChange={(e) => setEmployment(e.target.value)}
                    className="rounded-md border border-border bg-surface px-3 py-2 text-sm">
                    <option value="">Employment</option>
                    <option value="Full-time">Full-time</option>
                    <option value="Part-time">Part-time</option>
                    <option value="Contract">Contract</option>
                  </select>
                </div>
              </div>
            </div>

            <button
              onClick={handleSearch}
              disabled={searching || !selectedProfile}
              className="orchid-cta inline-flex items-center gap-2 rounded-full px-6 py-2.5 text-sm font-medium transition disabled:opacity-50 max-sm:min-h-[44px]"
            >
              {searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              Find Jobs
              <ArrowRight className="size-4" />
            </button>
          </div>
        </div>
      </section>

      <div className="mt-6 flex flex-wrap gap-3 text-sm">
        <Link href="/profiles" className="inline-flex items-center gap-1.5 text-muted hover:text-brand">
          <Plus className="size-3.5" /> Create another profile
        </Link>
        <Link href="/saved" className="inline-flex items-center gap-1.5 text-muted hover:text-brand">
          View saved jobs
        </Link>
      </div>
    </div>
  );
}
