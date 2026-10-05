import { NextResponse } from 'next/server';
import { crawlCompany, parseCompanies } from '@/lib/scavenger/companies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A full board crawl (hundreds of postings + matching) can run past a minute.
export const maxDuration = 300;

// POST /api/sc/companies/crawl
//   { company } → crawl one company (board + keyword supplement), match selected profiles
//   { text }    → parse-only: split chat-friendly input into companies (no crawling)
export async function POST(req: Request) {
  let body: { company?: unknown; text?: unknown; profileIds?: unknown; maxPages?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }

  if (typeof body.text === 'string' && typeof body.company !== 'string') {
    const parsed = await parseCompanies(body.text);
    return NextResponse.json(parsed);
  }

  const company = typeof body.company === 'string' ? body.company.trim().slice(0, 200) : '';
  if (!company) return NextResponse.json({ error: 'company is required (or text to parse)' }, { status: 400 });
  if (body.profileIds !== undefined && !Array.isArray(body.profileIds)) {
    return NextResponse.json({ error: 'profileIds must be an array' }, { status: 400 });
  }
  const maxPages =
    typeof body.maxPages === 'number' && Number.isInteger(body.maxPages)
      ? Math.min(50, Math.max(1, body.maxPages))
      : 25;

  const res = await crawlCompany({
    company,
    profileIds: Array.isArray(body.profileIds) ? body.profileIds.filter((x): x is string => typeof x === 'string') : undefined,
    maxPages,
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 422 });
  return NextResponse.json(res);
}
