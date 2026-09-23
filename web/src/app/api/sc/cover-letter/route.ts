import { NextRequest, NextResponse } from 'next/server';
import { renderCoverLetter, type CoverLetterData } from '@/lib/resume-templates';

// GET /api/sc/cover-letter?name=X&company=Y&position=Z&body=...&hiringManager=...&closing=...
export async function GET(req: NextRequest) {
  try {
    const data: CoverLetterData = {
      applicantName: req.nextUrl.searchParams.get('name') || '',
      companyName: req.nextUrl.searchParams.get('company') || '',
      position: req.nextUrl.searchParams.get('position') || '',
      hiringManager: req.nextUrl.searchParams.get('hiringManager') || undefined,
      body: req.nextUrl.searchParams.get('body') || '',
      closing: req.nextUrl.searchParams.get('closing') || undefined,
    };
    if (!data.applicantName || !data.companyName || !data.position || !data.body) {
      return NextResponse.json({ error: 'name, company, position, body are required' }, { status: 400 });
    }
    const html = renderCoverLetter(data);
    return new NextResponse(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
