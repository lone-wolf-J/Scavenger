# Scavenger

**Scavenger discovers, understands and matches opportunities against
multiple professional profiles.**

Scavenger is a general-purpose opportunity intelligence platform. It is
not a job scraper, and it is not built around any one profession.

## Model

```
USER
 ├── Documents (resumes, supporting material)
 └── Profiles
       ├── Profile A
       ├── Profile B
       └── Profile N
```

- One user ≠ one resume: many documents may feed many profiles.
- One user ≠ one profile: profiles are independent, duplicable, editable.
- One profile ≠ one job search: any profile can search the shared store.

A profile is not a resume. A resume is evidence; a profile is the
reviewed, confirmed model Scavenger matches against.

## Job intelligence (shared, profile-independent)

```
JOB SOURCES → NORMALIZATION → US/LOCATION FILTERING → DEDUPLICATION
    → EMPLOYER INTELLIGENCE → SHARED JOB STORE
```

No copy of a job is ever made per user or per profile. One canonical
record; matches reference it by ID.

## Matching (profile-specific)

```
USER PROFILE + SHARED JOB STORE → MATCHING → PERSONALIZED OPPORTUNITIES
```

One job can match many profiles with different scores. When several
profiles are selected, each opportunity is displayed once, retaining its
per-profile scores and explanations:

- Profile A — HR Leadership: 48
- Profile B — AI Leadership: 94
- Profile C — Consulting: 87

## Boundaries

- Core intelligence lives in domain libraries (`lib/`), never in UI code.
  Interfaces (CLI today, web tomorrow) call the libraries, not the reverse.
- No profession is hardcoded into the core. Professions exist only as
  test fixtures and example profiles.
- Authentication, payments, and subscriptions are explicitly future work.

## Relationship to CareerOps

This repository began as the CareerOps open-source project, whose
infrastructure (providers, tracker, evaluation modes) Scavenger builds
on. Internal identifiers, paths, environment variables, and upstream
documentation keep their existing names for compatibility; user-facing
product surfaces use the Scavenger name.
