import { NextRequest, NextResponse } from 'next/server';
import { listApplications, transitionApplicationStatus } from '@/lib/scavenger/applications';

// Interview scheduling API
// GET /api/sc/interviews — list upcoming interviews from applications in "Interview" status
// POST /api/sc/interviews — schedule a new interview (update application with date/time)

export async function GET() {
  try {
    const apps = await listApplications({ status: 'Interview' });
    // Also get Applied/Screened that might need scheduling
    const pendingApps = await listApplications({ status: 'Applied' });

    const interviews = (apps.applications || []).map((app: Record<string, unknown>) => ({
      id: app.id,
      jobId: app.jobId,
      company: app.company,
      position: app.jobTitle,
      status: app.status,
      scheduledAt: app.scheduledAt || null,
      interviewType: app.interviewType || null,
      notes: app.notes || '',
      url: app.url || '',
      applyUrl: app.applyUrl || '',
    }));

    return NextResponse.json({
      interviews,
      pendingSchedule: (pendingApps.applications || []).map((app: Record<string, unknown>) => ({
        id: app.id,
        jobId: app.jobId,
        company: app.company,
        position: app.jobTitle,
        status: app.status,
      })),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// POST /api/sc/interviews — schedule interview
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { applicationId, scheduledAt, interviewType, notes } = body;

    if (!applicationId) return NextResponse.json({ error: 'applicationId required' }, { status: 400 });

    // Transition to Interview status with scheduling details
    const result = await transitionApplicationStatus(applicationId, 'Interview', {
      detail: `Interview scheduled${scheduledAt ? ` for ${scheduledAt}` : ''}${interviewType ? ` (${interviewType})` : ''}${notes ? `. ${notes}` : ''}`,
    });

    if (!result.ok) return NextResponse.json({ error: result.error || 'transition failed' }, { status: 422 });

    return NextResponse.json({
      ok: true,
      application: result.application,
      message: `Interview scheduled for ${result.application.company || 'company'}`,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// DELETE /api/sc/interviews?id=X — cancel/reschedule interview
export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const result = await transitionApplicationStatus(id, 'Applied', {
      detail: 'Interview cancelled/rescheduled',
    });

    if (!result.ok) return NextResponse.json({ error: result.error || 'transition failed' }, { status: 422 });

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
