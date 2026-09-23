"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, ExternalLink, Send, Clock, CheckCircle, XCircle, Eye, Play, Pause, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/cn";

type Application = {
  applicationId: string; jobId: string; profileId: string; profileName: string;
  status: string; method: string; mode: string; applyUrl: string; url: string;
  jobTitle: string; company: string; location: string; resumeName: string;
  createdAt: string; updatedAt: string; submittedAt: string | null;
  failureReason: string | null;
};

type Metrics = { total: number; byStatus: Record<string, number> };

const STATUS_CONFIG: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; color: string; bg: string }> = {
  DISCOVERED:     { label: "Discovered", icon: Eye, color: "text-muted", bg: "bg-surface-hover" },
  SAVED:          { label: "Saved", icon: Eye, color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-500/10" },
  READY_TO_APPLY: { label: "Ready to apply", icon: Play, color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/10" },
  APPROVED:       { label: "Approved", icon: CheckCircle, color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/10" },
  PREPARING:      { label: "Preparing", icon: Loader2, color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-500/10" },
  IN_PROGRESS:    { label: "In progress", icon: Play, color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/10" },
  ACTION_REQUIRED:{ label: "Action required", icon: AlertTriangle, color: "text-orange-600 dark:text-orange-400", bg: "bg-orange-500/10" },
  SUBMITTED:      { label: "Submitted", icon: Send, color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/10" },
  FAILED:         { label: "Failed", icon: XCircle, color: "text-red-500 dark:text-red-400", bg: "bg-red-500/10" },
  REJECTED:       { label: "Rejected", icon: XCircle, color: "text-red-500 dark:text-red-400", bg: "bg-red-500/10" },
  WITHDRAWN:      { label: "Withdrawn", icon: XCircle, color: "text-muted", bg: "bg-surface-hover" },
  INTERVIEW:      { label: "Interview", icon: Play, color: "text-purple-600 dark:text-purple-400", bg: "bg-purple-500/10" },
  OFFER:          { label: "Offer", icon: CheckCircle, color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/10" },
  HIRED:          { label: "Hired", icon: CheckCircle, color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/10" },
};

function methodLabel(m: string): string {
  const map: Record<string, string> = {
    DIRECT_EMPLOYER: "Employer website", GREENHOUSE: "Greenhouse", WORKDAY: "Workday",
    LEVER: "Lever", ASHBY: "Ashby", LINKEDIN: "LinkedIn", DICE: "Dice", INDEED: "Indeed", OTHER: "Other",
  };
  return map[m] || m;
}

const TABS = ["all", "ACTION_REQUIRED", "IN_PROGRESS", "SUBMITTED", "INTERVIEW", "OFFER", "HIRED", "FAILED"] as const;

export function ApplicationsClient() {
  const [applications, setApplications] = useState<Application[]>([]);
  const [metrics, setMetrics] = useState<Metrics>({ total: 0, byStatus: {} });
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const q = filter !== "all" ? `?status=${filter}` : "";
    const res = await fetch(`/api/sc/applications${q}`);
    const data = await res.json();
    setApplications(data.applications || []);
    setMetrics(data.metrics || { total: 0, byStatus: {} });
    setLoading(false);
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  async function transition(appId: string, status: string) {
    await fetch("/api/sc/applications", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ applicationId: appId, status }),
    });
    load();
  }

  const filtered = filter === "all" ? applications : applications.filter((a) => a.status === filter);

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">Applications</h1>
          <p className="mt-1 text-sm text-muted">Track your applications from discovery to hire. {metrics.total} total.</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {TABS.map((t) => {
          const count = t === "all" ? metrics.total : (metrics.byStatus[t] || 0);
          return (
            <button key={t} onClick={() => setFilter(t)}
              className={cn("rounded-full border px-3 py-1.5 text-xs transition-colors",
                filter === t ? "border-brand/50 bg-brand/10 text-foreground" : "border-border text-muted hover:bg-surface-hover hover:text-foreground")}>
              {t === "all" ? "All" : t.replace(/_/g, " ")} {count > 0 && <span className="ml-1 tabular-nums">({count})</span>}
            </button>
          );
        })}
      </div>

      {loading && <div className="mt-4 flex items-center gap-2 text-sm text-muted"><Loader2 className="size-4 animate-spin" /> Loading...</div>}

      {!loading && filtered.length === 0 && (
        <div className="mt-8 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center text-sm text-muted">
          {applications.length === 0 ? (
            <>
              No applications yet. Click <span className="text-foreground">Apply</span> on a job in <Link href="/jobs" className="text-brand hover:underline">Jobs</Link> to start.
            </>
          ) : (
            <>No applications with status "{filter.replace(/_/g, " ")}".</>
          )}
        </div>
      )}

      <div className="mt-4 space-y-3">
        {filtered.map((app) => {
          const st = STATUS_CONFIG[app.status] || STATUS_CONFIG.DISCOVERED;
          const Icon = st.icon;
          const isExpanded = expanded === app.applicationId;
          return (
            <div key={app.applicationId} className="rounded-2xl border border-border bg-surface/30 px-5 py-4 transition-colors hover:bg-surface/50">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-foreground">{app.jobTitle || "Unknown role"}</div>
                  <div className="mt-0.5 text-xs text-muted">
                    {app.company}{app.location ? ` \u00b7 ${app.location}` : ""} \u00b7 {app.profileName}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs", st.bg, st.color)}>
                      <Icon className={cn("size-3", app.status === "PREPARING" && "animate-spin")} /> {st.label}
                    </span>
                    <span className="text-xs text-muted">{methodLabel(app.method)}</span>
                    {app.resumeName && <span className="text-xs text-muted">\u00b7 {app.resumeName}</span>}
                  </div>
                </div>
                <div className="shrink-0 text-right text-xs text-muted">
                  <div>{new Date(app.updatedAt).toLocaleDateString()}</div>
                  {app.submittedAt && <div className="text-emerald-600 dark:text-emerald-400">Submitted {new Date(app.submittedAt).toLocaleDateString()}</div>}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                {app.status === "ACTION_REQUIRED" && (app.applyUrl || app.url) && (
                  <a href={app.applyUrl || app.url} target="_blank" rel="noreferrer"
                    onClick={() => {}} // URL opens automatically
                    className="inline-flex items-center gap-1 rounded-md bg-brand/10 border border-brand/30 px-2.5 py-1.5 text-brand hover:bg-brand/20">
                    <ExternalLink className="size-3" /> Continue Application
                  </a>
                )}
                {app.status === "READY_TO_APPLY" && (
                  <button onClick={() => transition(app.applicationId, "APPROVED")}
                    className="inline-flex items-center gap-1 rounded-md bg-brand/10 border border-brand/30 px-2.5 py-1.5 text-brand hover:bg-brand/20">
                    <Play className="size-3" /> Start Application
                  </button>
                )}
                {app.status === "SUBMITTED" && (
                  <button onClick={() => transition(app.applicationId, "INTERVIEW")}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-muted hover:bg-surface-hover hover:text-foreground">
                    Mark Interview
                  </button>
                )}
                {app.status === "INTERVIEW" && (
                  <button onClick={() => transition(app.applicationId, "OFFER")}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-muted hover:bg-surface-hover hover:text-foreground">
                    Mark Offer
                  </button>
                )}
                {app.status === "FAILED" && (
                  <button onClick={() => transition(app.applicationId, "READY_TO_APPLY")}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-muted hover:bg-surface-hover hover:text-foreground">
                    Retry
                  </button>
                )}
                <button onClick={() => setExpanded(isExpanded ? null : app.applicationId)}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-muted hover:bg-surface-hover hover:text-foreground">
                  Details
                </button>
                {(app.url || app.applyUrl) && (
                  <a href={app.applyUrl || app.url} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-muted hover:bg-surface-hover hover:text-foreground">
                    <ExternalLink className="size-3" /> View Job
                  </a>
                )}
              </div>

              {isExpanded && (
                <div className="mt-3 space-y-1.5 border-t border-border pt-3 text-xs text-muted">
                  <div><span className="text-foreground">Application ID:</span> {app.applicationId}</div>
                  <div><span className="text-foreground">Created:</span> {new Date(app.createdAt).toLocaleString()}</div>
                  <div><span className="text-foreground">Mode:</span> {app.mode}</div>
                  {app.failureReason && <div><span className="text-foreground">Failure reason:</span> {app.failureReason}</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
