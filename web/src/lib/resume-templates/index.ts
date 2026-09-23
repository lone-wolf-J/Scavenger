// Resume template engine — generates clean, ATS-friendly HTML from user profile data.
// Templates are defined inline for portability; each returns a complete HTML document.

export interface ResumeData {
  name: string;
  email: string;
  phone?: string;
  location?: string;
  linkedin?: string;
  website?: string;
  summary?: string;
  experience: Experience[];
  education: Education[];
  skills: string[];
  certifications?: string[];
  projects?: Project[];
}

interface Experience {
  company: string;
  title: string;
  startDate: string;
  endDate?: string;
  description: string[];
  location?: string;
}

interface Education {
  school: string;
  degree: string;
  field?: string;
  startDate?: string;
  endDate?: string;
  gpa?: string;
}

interface Project {
  name: string;
  url?: string;
  description: string;
}

type TemplateName = 'basic' | 'professional' | 'creative';

// --- CSS Styles ---

const baseStyles = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333; line-height: 1.5; }
  a { color: #2563eb; text-decoration: none; }
  .page { max-width: 800px; margin: 0 auto; padding: 40px; }
  .header { margin-bottom: 24px; }
  .name { font-size: 28px; font-weight: 700; color: #111; }
  .contact { display: flex; flex-wrap: wrap; gap: 12px; font-size: 13px; color: #666; margin-top: 6px; }
  .section { margin-bottom: 20px; }
  .section-title { font-size: 15px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 2px solid #e5e7eb; padding-bottom: 4px; margin-bottom: 10px; color: #374151; }
  .entry { margin-bottom: 14px; }
  .entry-header { display: flex; justify-content: space-between; align-items: baseline; }
  .entry-title { font-weight: 600; font-size: 15px; }
  .entry-subtitle { font-size: 13px; color: #6b7280; }
  .entry-date { font-size: 13px; color: #9ca3af; white-space: nowrap; }
  .entry-desc { margin-top: 4px; }
  .entry-desc ul { padding-left: 18px; }
  .entry-desc li { font-size: 13px; margin-bottom: 2px; }
  .skills { display: flex; flex-wrap: wrap; gap: 6px; }
  .skill { background: #f3f4f6; padding: 3px 10px; border-radius: 4px; font-size: 12px; }
  .summary { font-size: 14px; color: #4b5563; }
  @media print { .page { padding: 20px; } }
`;

// --- Template Renderers ---

function renderBasic(data: ResumeData): string {
  const contactParts = [data.email, data.phone, data.location, data.linkedin, data.website].filter(Boolean);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Resume - ${data.name}</title><style>${baseStyles}</style></head><body>
<div class="page">
  <div class="header">
    <div class="name">${esc(data.name)}</div>
    <div class="contact">${contactParts.map((c) => `<span>${esc(c)}</span>`).join('')}</div>
  </div>
  ${data.summary ? `<div class="section"><div class="section-title">Summary</div><div class="summary">${esc(data.summary)}</div></div>` : ''}
  ${data.experience.length ? `<div class="section"><div class="section-title">Experience</div>${data.experience.map(renderExp).join('')}</div>` : ''}
  ${data.education.length ? `<div class="section"><div class="section-title">Education</div>${data.education.map(renderEdu).join('')}</div>` : ''}
  ${data.skills.length ? `<div class="section"><div class="section-title">Skills</div><div class="skills">${data.skills.map((s) => `<span class="skill">${esc(s)}</span>`).join('')}</div></div>` : ''}
  ${data.projects?.length ? `<div class="section"><div class="section-title">Projects</div>${data.projects.map(renderProject).join('')}</div>` : ''}
</div></body></html>`;
}

function renderProfessional(data: ResumeData): string {
  const contactParts = [data.email, data.phone, data.location, data.linkedin, data.website].filter(Boolean);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Resume - ${data.name}</title><style>
    ${baseStyles}
    .name { font-size: 32px; color: #1e3a5f; border-bottom: 3px solid #1e3a5f; padding-bottom: 8px; }
    .section-title { color: #1e3a5f; border-bottom-color: #1e3a5f; }
    .entry-title { color: #1e3a5f; }
  </style></head><body>
<div class="page">
  <div class="header">
    <div class="name">${esc(data.name)}</div>
    <div class="contact">${contactParts.map((c) => `<span>${esc(c)}</span>`).join('')}</div>
  </div>
  ${data.summary ? `<div class="section"><div class="section-title">Professional Summary</div><div class="summary">${esc(data.summary)}</div></div>` : ''}
  ${data.experience.length ? `<div class="section"><div class="section-title">Professional Experience</div>${data.experience.map(renderExp).join('')}</div>` : ''}
  ${data.education.length ? `<div class="section"><div class="section-title">Education</div>${data.education.map(renderEdu).join('')}</div>` : ''}
  ${data.skills.length ? `<div class="section"><div class="section-title">Core Competencies</div><div class="skills">${data.skills.map((s) => `<span class="skill">${esc(s)}</span>`).join('')}</div></div>` : ''}
  ${data.projects?.length ? `<div class="section"><div class="section-title">Projects</div>${data.projects.map(renderProject).join('')}</div>` : ''}
  ${data.certifications?.length ? `<div class="section"><div class="section-title">Certifications</div><div class="entry-desc"><ul>${data.certifications.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div></div>` : ''}
</div></body></html>`;
}

function renderCreative(data: ResumeData): string {
  const contactParts = [data.email, data.phone, data.location, data.linkedin, data.website].filter(Boolean);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Resume - ${data.name}</title><style>
    ${baseStyles}
    body { background: #fafafa; }
    .page { background: white; box-shadow: 0 2px 12px rgba(0,0,0,0.08); border-radius: 8px; }
    .name { font-size: 30px; color: #7c3aed; }
    .section-title { color: #7c3aed; border-bottom-color: #ddd6fe; }
    .entry-title { color: #6d28d9; }
    .skill { background: #ede9fe; color: #6d28d9; }
    .contact { color: #6b7280; }
  </style></head><body>
<div class="page">
  <div class="header">
    <div class="name">${esc(data.name)}</div>
    <div class="contact">${contactParts.map((c) => `<span>${esc(c)}</span>`).join('')}</div>
  </div>
  ${data.summary ? `<div class="section"><div class="section-title">About Me</div><div class="summary">${esc(data.summary)}</div></div>` : ''}
  ${data.experience.length ? `<div class="section"><div class="section-title">Experience</div>${data.experience.map(renderExp).join('')}</div>` : ''}
  ${data.education.length ? `<div class="section"><div class="section-title">Education</div>${data.education.map(renderEdu).join('')}</div>` : ''}
  ${data.skills.length ? `<div class="section"><div class="section-title">Skills</div><div class="skills">${data.skills.map((s) => `<span class="skill">${esc(s)}</span>`).join('')}</div></div>` : ''}
  ${data.projects?.length ? `<div class="section"><div class="section-title">Projects</div>${data.projects.map(renderProject).join('')}</div>` : ''}
</div></body></html>`;
}

// --- Helpers ---

function esc(s: string | undefined): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderExp(exp: Experience): string {
  const date = [exp.startDate, exp.endDate || 'Present'].filter(Boolean).join(' — ');
  return `<div class="entry">
    <div class="entry-header">
      <div><span class="entry-title">${esc(exp.title)}</span>${exp.company ? ` · <span class="entry-subtitle">${esc(exp.company)}</span>` : ''}</div>
      <span class="entry-date">${esc(date)}</span>
    </div>
    ${exp.location ? `<div class="entry-subtitle">${esc(exp.location)}</div>` : ''}
    ${exp.description.length ? `<div class="entry-desc"><ul>${exp.description.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>` : ''}
  </div>`;
}

function renderEdu(edu: Education): string {
  const date = [edu.startDate, edu.endDate].filter(Boolean).join(' — ');
  return `<div class="entry">
    <div class="entry-header">
      <div><span class="entry-title">${esc(edu.school)}</span></div>
      ${date ? `<span class="entry-date">${esc(date)}</span>` : ''}
    </div>
    <div class="entry-subtitle">${esc(edu.degree)}${edu.field ? ` in ${esc(edu.field)}` : ''}${edu.gpa ? ` · GPA: ${esc(edu.gpa)}` : ''}</div>
  </div>`;
}

function renderProject(proj: Project): string {
  return `<div class="entry">
    <div class="entry-header">
      <span class="entry-title">${esc(proj.name)}</span>
    </div>
    ${proj.url ? `<a href="${esc(proj.url)}" class="entry-subtitle">${esc(proj.url)}</a>` : ''}
    <div class="entry-desc"><ul><li>${esc(proj.description)}</li></ul></div>
  </div>`;
}

// --- Cover Letter ---

export interface CoverLetterData {
  applicantName: string;
  companyName: string;
  position: string;
  hiringManager?: string;
  body: string;
  closing?: string;
}

export function renderCoverLetter(data: CoverLetterData): string {
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const greeting = data.hiringManager ? `Dear ${esc(data.hiringManager)},` : 'Dear Hiring Manager,';
  const closing = data.closing || 'Sincerely,';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Cover Letter - ${data.position} at ${data.companyName}</title><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Georgia', serif; color: #333; line-height: 1.6; }
    .page { max-width: 700px; margin: 0 auto; padding: 60px 40px; }
    .date { margin-bottom: 24px; font-size: 14px; }
    .greeting { margin-bottom: 16px; font-size: 15px; }
    .body { font-size: 14px; margin-bottom: 24px; white-space: pre-wrap; }
    .closing { font-size: 14px; margin-bottom: 32px; }
    .signature { font-size: 14px; font-weight: 600; }
    @media print { .page { padding: 40px; } }
  </style></head><body>
<div class="page">
  <div class="date">${today}</div>
  <div class="greeting">${greeting}</div>
  <div class="body">${esc(data.body)}</div>
  <div class="closing">${closing}</div>
  <div class="signature">${esc(data.applicantName)}</div>
</div></body></html>`;
}

// --- Public API ---

const TEMPLATES: Record<TemplateName, (data: ResumeData) => string> = {
  basic: renderBasic,
  professional: renderProfessional,
  creative: renderCreative,
};

export const TEMPLATE_NAMES: TemplateName[] = ['basic', 'professional', 'creative'];

export function renderResume(data: ResumeData, template: TemplateName = 'professional'): string {
  const renderer = TEMPLATES[template] || TEMPLATES.professional;
  return renderer(data);
}

export function resumeDataFromProfile(profile: Record<string, unknown>): ResumeData {
  const p = profile as Record<string, string>;
  return {
    name: p.name || p.fullName || '',
    email: p.email || '',
    phone: p.phone || '',
    location: p.location || p.city || '',
    linkedin: p.linkedin || p.linkedinUrl || '',
    website: p.website || p.portfolio || '',
    summary: p.summary || p.objective || '',
    experience: Array.isArray(p.experience) ? p.experience : [],
    education: Array.isArray(p.education) ? p.education : [],
    skills: Array.isArray(p.skills) ? p.skills : typeof p.skills === 'string' ? p.skills.split(',').map((s: string) => s.trim()) : [],
    certifications: Array.isArray(p.certifications) ? p.certifications : [],
    projects: Array.isArray(p.projects) ? p.projects : [],
  };
}
