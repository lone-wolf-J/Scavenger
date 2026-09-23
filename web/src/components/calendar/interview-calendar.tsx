"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Calendar,
  Clock,
  ChevronLeft,
  ChevronRight,
  Plus,
  Video,
  Phone,
  MapPin,
  Loader2,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/cn";

interface Interview {
  id: string;
  jobId: string;
  company: string;
  position: string;
  status: string;
  scheduledAt: string | null;
  interviewType: string | null;
  notes: string;
  url: string;
  applyUrl: string;
}

interface ScheduleForm {
  applicationId: string;
  scheduledAt: string;
  interviewType: string;
  notes: string;
}

const INTERVIEW_TYPES = ["Phone Screen", "Video Call", "On-site", "Technical", "Behavioral", "Panel", "Other"];

export function InterviewCalendar() {
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [pending, setPending] = useState<{ id: string; company: string; position: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSchedule, setShowSchedule] = useState(false);
  const [form, setForm] = useState<ScheduleForm>({ applicationId: "", scheduledAt: "", interviewType: "Video Call", notes: "" });
  const [saving, setSaving] = useState(false);
  const [currentMonth, setCurrentMonth] = useState(new Date());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/sc/interviews");
      const data = await res.json();
      setInterviews(data.interviews || []);
      setPending(data.pendingSchedule || []);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function scheduleInterview() {
    if (!form.applicationId) return;
    setSaving(true);
    try {
      const res = await fetch("/api/sc/interviews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        setShowSchedule(false);
        setForm({ applicationId: "", scheduledAt: "", interviewType: "Video Call", notes: "" });
        load();
      }
    } catch {}
    setSaving(false);
  }

  // Calendar helpers
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];

  function prevMonth() { setCurrentMonth(new Date(year, month - 1, 1)); }
  function nextMonth() { setCurrentMonth(new Date(year, month + 1, 1)); }

  function interviewsForDay(dateStr: string) {
    return interviews.filter((i) => i.scheduledAt && i.scheduledAt.startsWith(dateStr));
  }

  const monthName = currentMonth.toLocaleString("default", { month: "long", year: "numeric" });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Calendar className="size-5" /> Interview Calendar
          </h2>
          <p className="text-xs text-muted mt-0.5">{interviews.length} upcoming interview{interviews.length !== 1 ? "s" : ""}</p>
        </div>
        <button onClick={() => setShowSchedule(!showSchedule)}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-foreground hover:bg-brand-200">
          <Plus className="size-4" /> Schedule
        </button>
      </div>

      {/* Schedule form */}
      {showSchedule && (
        <div className="rounded-lg border border-border bg-surface p-4 space-y-3">
          <h3 className="text-sm font-semibold text-foreground">Schedule Interview</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs text-muted">Application</label>
              <select value={form.applicationId} onChange={(e) => setForm({ ...form, applicationId: e.target.value })}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
                <option value="">Select application...</option>
                {pending.map((p) => (
                  <option key={p.id} value={p.id}>{p.company} — {p.position}</option>
                ))}
                {interviews.map((i) => (
                  <option key={i.id} value={i.id}>{i.company} — {i.position} (reschedule)</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted">Date & Time</label>
              <input type="datetime-local" value={form.scheduledAt}
                onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs text-muted">Type</label>
              <select value={form.interviewType} onChange={(e) => setForm({ ...form, interviewType: e.target.value })}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
                {INTERVIEW_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted">Notes</label>
              <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Interviewer name, prep notes..."
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={scheduleInterview} disabled={saving || !form.applicationId}
              className="inline-flex items-center gap-1.5 rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:bg-brand-200 disabled:opacity-50">
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Calendar className="size-3.5" />}
              Save
            </button>
            <button onClick={() => setShowSchedule(false)} className="rounded-md border border-border px-4 py-2 text-sm text-muted hover:bg-surface-hover">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Calendar grid */}
      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <button onClick={prevMonth} className="rounded-md p-1 text-muted hover:bg-surface-hover"><ChevronLeft className="size-4" /></button>
          <h3 className="text-sm font-semibold text-foreground">{monthName}</h3>
          <button onClick={nextMonth} className="rounded-md p-1 text-muted hover:bg-surface-hover"><ChevronRight className="size-4" /></button>
        </div>
        <div className="grid grid-cols-7 text-center text-xs text-muted border-b border-border">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
            <div key={d} className="py-2 font-medium">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {/* Empty cells for days before month starts */}
          {Array.from({ length: firstDay }).map((_, i) => (
            <div key={`empty-${i}`} className="h-20 border-b border-r border-border/50 bg-background/30" />
          ))}
          {/* Day cells */}
          {Array.from({ length: daysInMonth }).map((_, i) => {
            const day = i + 1;
            const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            const isToday = dateStr === todayStr;
            const dayInterviews = interviewsForDay(dateStr);

            return (
              <div key={day} className={cn("h-20 border-b border-r border-border/50 p-1 text-left", isToday && "bg-brand-soft/30")}>
                <span className={cn("text-xs font-medium", isToday ? "text-brand font-bold" : "text-muted")}>{day}</span>
                {dayInterviews.map((interview) => (
                  <div key={interview.id}
                    className="mt-0.5 rounded bg-brand/10 px-1 py-0.5 text-[10px] text-brand truncate font-medium"
                    title={`${interview.company} — ${interview.position}${interview.interviewType ? ` (${interview.interviewType})` : ""}`}>
                    {interview.company}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* Upcoming list */}
      {interviews.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3">Upcoming Interviews</h3>
          <div className="space-y-2">
            {interviews.sort((a, b) => (a.scheduledAt || "").localeCompare(b.scheduledAt || "")).map((interview) => (
              <div key={interview.id} className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex size-9 items-center justify-center rounded-full bg-brand-soft text-brand">
                    <Calendar className="size-4" />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-foreground">{interview.company} — {interview.position}</div>
                    <div className="flex items-center gap-3 text-xs text-muted">
                      {interview.scheduledAt && (
                        <span className="flex items-center gap-1">
                          <Clock className="size-3" />
                          {new Date(interview.scheduledAt).toLocaleString()}
                        </span>
                      )}
                      {interview.interviewType && <span>{interview.interviewType}</span>}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {interview.url && (
                    <a href={interview.url} target="_blank" rel="noopener noreferrer"
                      className="rounded-md p-1.5 text-muted hover:bg-surface-hover">
                      <ExternalLink className="size-3.5" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {interviews.length === 0 && !loading && (
        <div className="rounded-lg border border-dashed border-border py-12 text-center">
          <Calendar className="mx-auto size-8 text-muted/50" />
          <p className="mt-2 text-sm text-muted">No upcoming interviews</p>
          <p className="text-xs text-muted/70">Schedule one from your tracked applications</p>
        </div>
      )}
    </div>
  );
}
