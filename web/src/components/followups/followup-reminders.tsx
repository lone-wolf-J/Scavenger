"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Bell,
  Clock,
  AlertTriangle,
  CheckCircle,
  Mail,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/cn";

interface FollowupItem {
  id: string;
  company: string;
  position: string;
  status: string;
  appliedDate: string;
  daysSinceApplied: number;
  followupDue: string;
  overdue: boolean;
  daysOverdue: number;
}

interface FollowupSummary {
  total: number;
  overdue: number;
  dueToday: number;
  dueThisWeek: number;
}

export function FollowupReminders() {
  const [followups, setFollowups] = useState<FollowupItem[]>([]);
  const [summary, setSummary] = useState<FollowupSummary>({ total: 0, overdue: 0, dueToday: 0, dueThisWeek: 0 });
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "overdue" | "due-today">("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/sc/followups");
      const data = await res.json();
      setFollowups(data.followups || []);
      setSummary(data.summary || { total: 0, overdue: 0, dueToday: 0, dueThisWeek: 0 });
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = followups.filter((f) => {
    if (filter === "overdue") return f.overdue;
    if (filter === "due-today") return f.followupDue <= new Date().toISOString().split("T")[0] && !f.overdue;
    return true;
  });

  function copyFollowupEmail(item: FollowupItem) {
    const subject = `Following up — ${item.position} Application`;
    const body = `Hi,\n\nI wanted to follow up on my application for the ${item.position} position at ${item.company}, submitted on ${item.appliedDate}.\n\nI remain very interested in this opportunity and would love to hear about next steps.\n\nThank you for your time.\n\nBest regards`;
    const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(mailto, "_blank");
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <Bell className="size-5" /> Follow-up Reminders
        </h2>
        <p className="text-xs text-muted mt-0.5">Track when to follow up on pending applications</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Total Pending", value: summary.total, icon: Clock, color: "text-muted" },
          { label: "Overdue", value: summary.overdue, icon: AlertTriangle, color: "text-red-500" },
          { label: "Due Today", value: summary.dueToday, icon: Bell, color: "text-amber-500" },
          { label: "Due This Week", value: summary.dueThisWeek, icon: CheckCircle, color: "text-blue-500" },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="rounded-lg border border-border bg-surface p-3">
            <div className="flex items-center gap-2">
              <Icon className={cn("size-4", color)} />
              <span className="text-xs text-muted">{label}</span>
            </div>
            <div className="mt-1 text-2xl font-bold text-foreground">{value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-1 rounded-lg border border-border p-1 w-fit">
        {(["all", "overdue", "due-today"] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={cn("rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              filter === f ? "bg-surface text-foreground" : "text-muted hover:bg-surface-hover"
            )}>
            {f === "all" ? "All" : f === "overdue" ? "Overdue" : "Due Today"}
          </button>
        ))}
      </div>

      {/* Follow-up list */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted" />
        </div>
      ) : filtered.length > 0 ? (
        <div className="space-y-2">
          {filtered.map((item) => (
            <div key={item.id} className={cn(
              "flex items-center justify-between rounded-lg border bg-surface px-4 py-3 transition-colors",
              item.overdue ? "border-red-500/30 bg-red-500/5" : "border-border"
            )}>
              <div className="flex items-center gap-3">
                <div className={cn(
                  "flex size-9 items-center justify-center rounded-full",
                  item.overdue ? "bg-red-500/10 text-red-500" : "bg-brand-soft text-brand"
                )}>
                  {item.overdue ? <AlertTriangle className="size-4" /> : <Bell className="size-4" />}
                </div>
                <div>
                  <div className="text-sm font-medium text-foreground">{item.company} — {item.position}</div>
                  <div className="flex items-center gap-3 text-xs text-muted">
                    <span>Applied {item.appliedDate}</span>
                    <span>{item.daysSinceApplied}d ago</span>
                    <span className={item.overdue ? "text-red-500 font-medium" : ""}>
                      {item.overdue ? `${item.daysOverdue}d overdue` : `Follow up by ${item.followupDue}`}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => copyFollowupEmail(item)}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs text-muted hover:bg-surface-hover">
                  <Mail className="size-3" /> Draft Email
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border py-12 text-center">
          <CheckCircle className="mx-auto size-8 text-green-500/50" />
          <p className="mt-2 text-sm text-muted">
            {filter === "overdue" ? "No overdue follow-ups" : filter === "due-today" ? "Nothing due today" : "No pending follow-ups"}
          </p>
          <p className="text-xs text-muted/70">All caught up!</p>
        </div>
      )}
    </div>
  );
}
