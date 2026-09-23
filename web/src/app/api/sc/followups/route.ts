import { NextRequest, NextResponse } from 'next/server';
import { listApplications } from '@/lib/scavenger/applications';

// Follow-up reminder API
// GET /api/sc/followups — returns applications that need follow-up
// Configurable cadence: default 5 business days after application

const DEFAULT_CADENCE_DAYS = 5;

function addBusinessDays(date: Date, days: number): Date {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const dow = result.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return result;
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

export async function GET(req: NextRequest) {
  try {
    const cadenceDays = parseInt(req.nextUrl.searchParams.get('days') || String(DEFAULT_CADENCE_DAYS), 10);
    const today = new Date();
    const todayStr = formatDate(today);

    // Get all applications that are in "Applied" or "Screened" status (awaiting response)
    const applied = await listApplications({ status: 'Applied' });
    const screened = await listApplications({ status: 'Screened' });

    const allPending = [...(applied.applications || []), ...(screened.applications || [])];
    const needsFollowup: Array<{
      id: string;
      company: string;
      position: string;
      status: string;
      appliedDate: string;
      daysSinceApplied: number;
      followupDue: string;
      overdue: boolean;
      daysOverdue: number;
    }> = [];

    for (const app of allPending) {
      const appliedAt = (app.appliedAt as string) || (app.createdAt as string) || '';
      if (!appliedAt) continue;

      const appliedDate = new Date(appliedAt);
      const followupDate = addBusinessDays(appliedDate, cadenceDays);
      const followupStr = formatDate(followupDate);
      const daysSince = Math.floor((today.getTime() - appliedDate.getTime()) / (1000 * 60 * 60 * 24));
      const isOverdue = todayStr >= followupStr;

      needsFollowup.push({
        id: app.id as string,
        company: (app.company as string) || '',
        position: (app.jobTitle as string) || '',
        status: (app.status as string) || '',
        appliedDate: appliedAt.split('T')[0],
        daysSinceApplied: daysSince,
        followupDue: followupStr,
        overdue: isOverdue,
        daysOverdue: isOverdue ? Math.floor((today.getTime() - followupDate.getTime()) / (1000 * 60 * 60 * 24)) : 0,
      });
    }

    // Sort: overdue first (most overdue first), then by follow-up date
    needsFollowup.sort((a, b) => {
      if (a.overdue && !b.overdue) return -1;
      if (!a.overdue && b.overdue) return 1;
      if (a.overdue && b.overdue) return b.daysOverdue - a.daysOverdue;
      return a.followupDue.localeCompare(b.followupDue);
    });

    return NextResponse.json({
      followups: needsFollowup,
      cadenceDays,
      summary: {
        total: needsFollowup.length,
        overdue: needsFollowup.filter((f) => f.overdue).length,
        dueToday: needsFollowup.filter((f) => f.followupDue === todayStr && !f.overdue).length,
        dueThisWeek: needsFollowup.filter((f) => {
          const d = new Date(f.followupDue);
          const diff = Math.ceil((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
          return diff >= 0 && diff <= 7;
        }).length,
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
