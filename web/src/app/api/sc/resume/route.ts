import { NextRequest, NextResponse } from 'next/server';
import { getProfile } from '@/lib/scavenger/profiles';
import { renderResume, resumeDataFromProfile, TEMPLATE_NAMES } from '@/lib/resume-templates';

// GET /api/sc/resume?profileId=X&template=professional
export async function GET(req: NextRequest) {
  try {
    const profileId = req.nextUrl.searchParams.get('profileId');
    const template = req.nextUrl.searchParams.get('template') || 'professional';
    if (!profileId) return NextResponse.json({ error: 'profileId required' }, { status: 400 });
    if (!TEMPLATE_NAMES.includes(template as never)) return NextResponse.json({ error: `template must be one of: ${TEMPLATE_NAMES.join(', ')}` }, { status: 400 });

    const profile = await getProfile(profileId);
    if (!profile) return NextResponse.json({ error: 'profile not found' }, { status: 404 });

    const data = resumeDataFromProfile(profile.profile || profile);
    const html = renderResume(data, template as never);
    return new NextResponse(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
