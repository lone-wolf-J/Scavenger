import { NextRequest, NextResponse } from 'next/server';
import { getProfile } from '@/lib/scavenger/profiles';

interface AutofillPayload {
  profileId: string;
  jobUrl?: string;
  companyName?: string;
  position?: string;
  customFields?: Record<string, string>;
}

// Common application form fields mapped to profile data
const FIELD_MAP: Record<string, (p: Record<string, unknown>) => string> = {
  'first_name': (p) => (p.firstName as string) || (p.name as string)?.split(' ')[0] || '',
  'last_name': (p) => (p.lastName as string) || (p.name as string)?.split(' ').slice(1).join(' ') || '',
  'full_name': (p) => (p.name as string) || (p.fullName as string) || '',
  'email': (p) => (p.email as string) || '',
  'phone': (p) => (p.phone as string) || '',
  'location': (p) => (p.location as string) || '',
  'city': (p) => (p.city as string) || (p.location as string)?.split(',')[0] || '',
  'state': (p) => (p.state as string) || '',
  'country': (p) => (p.country as string) || '',
  'zip_code': (p) => (p.zipCode as string) || (p.postalCode as string) || '',
  'address': (p) => (p.address as string) || '',
  'linkedin': (p) => (p.linkedin as string) || '',
  'website': (p) => (p.website as string) || (p.portfolio as string) || '',
  'github': (p) => (p.github as string) || '',
  'portfolio': (p) => (p.portfolio as string) || (p.website as string) || '',
  'current_company': (p) => (p.currentCompany as string) || (p.company as string) || '',
  'current_title': (p) => (p.currentTitle as string) || (p.title as string) || '',
  'years_experience': (p) => String(p.yearsExperience || p.experience || ''),
  'education': (p) => {
    const edu = p.education;
    if (Array.isArray(edu) && edu.length > 0) {
      const e = edu[0] as Record<string, string>;
      return [e.degree, e.field, e.school].filter(Boolean).join(' — ');
    }
    return (p.education as string) || '';
  },
  'skills': (p) => {
    const s = p.skills;
    if (Array.isArray(s)) return s.join(', ');
    return (s as string) || '';
  },
  'desired_salary': (p) => (p.desiredSalary as string) || (p.salaryExpectation as string) || '',
  'work_authorization': (p) => (p.workAuthorization as string) || '',
  'willing_to_relocate': (p) => (p.willingToRelocate as string) || '',
  'start_date': (p) => (p.availableStartDate as string) || '',
  'linkedin_url': (p) => (p.linkedin as string) || '',
  'cover_letter': () => '', // Generated separately
  'how_did_you_hear': (p) => (p.referralSource as string) || '',
  'gender': (p) => (p.gender as string) || '',
  'pronouns': (p) => (p.pronouns as string) || '',
  'veteran_status': (p) => (p.veteranStatus as string) || '',
  'disability_status': (p) => (p.disabilityStatus as string) || '',
  'equal_opportunity': () => '', // Decline to self-identify
};

// POST /api/sc/autofill — returns a map of form fields to profile values
export async function POST(req: NextRequest) {
  try {
    const body: AutofillPayload = await req.json();
    const { profileId, customFields } = body;

    if (!profileId) return NextResponse.json({ error: 'profileId required' }, { status: 400 });

    const profile = await getProfile(profileId);
    if (!profile) return NextResponse.json({ error: 'profile not found' }, { status: 404 });

    const p = (profile.profile || profile) as Record<string, unknown>;
    const fills: Record<string, string> = {};

    // Map all known fields
    for (const [field, extractor] of Object.entries(FIELD_MAP)) {
      const value = extractor(p);
      if (value) fills[field] = value;
    }

    // Merge custom overrides
    if (customFields) {
      for (const [k, v] of Object.entries(customFields)) {
        if (v) fills[k] = v;
      }
    }

    return NextResponse.json({
      profileId,
      profileName: profile.name,
      fills,
      fieldCount: Object.keys(fills).length,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
