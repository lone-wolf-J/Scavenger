"use client";

import { useCallback, useEffect, useState } from "react";
import {
  FileText,
  Mail,
  Download,
  Loader2,
  Eye,
  Palette,
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/cn";

type Profile = { id: string; name: string; profile?: Record<string, unknown> };
type TemplateName = "basic" | "professional" | "creative";

const TEMPLATES: { id: TemplateName; label: string; description: string }[] = [
  { id: "basic", label: "Basic", description: "Clean, minimal — best for ATS" },
  { id: "professional", label: "Professional", description: "Structured with navy accents" },
  { id: "creative", label: "Creative", description: "Purple theme, rounded cards" },
];

interface ResumeData {
  name: string;
  email: string;
  phone: string;
  location: string;
  linkedin: string;
  website: string;
  summary: string;
  experience: { company: string; title: string; startDate: string; endDate: string; description: string; location: string }[];
  education: { school: string; degree: string; field: string; startDate: string; endDate: string }[];
  skills: string[];
}

const EMPTY: ResumeData = {
  name: "", email: "", phone: "", location: "", linkedin: "", website: "", summary: "",
  experience: [], education: [], skills: [],
};

export function ResumeBuilder() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState("");
  const [template, setTemplate] = useState<TemplateName>("professional");
  const [data, setData] = useState<ResumeData>(EMPTY);
  const [skillInput, setSkillInput] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"edit" | "preview">("edit");

  useEffect(() => {
    fetch("/api/sc/profiles")
      .then((r) => r.json())
      .then((d) => {
        const active = (d.profiles || []).filter((p: Profile & { state?: string }) => p.state !== "archived");
        setProfiles(active);
        if (active.length > 0) setSelectedProfile(active[0].id);
      })
      .catch(() => {});
  }, []);

  const loadFromProfile = useCallback(async () => {
    if (!selectedProfile) return;
    const profile = profiles.find((p) => p.id === selectedProfile);
    if (!profile) return;
    const p = (profile.profile || {}) as Record<string, string>;
    setData({
      name: (p.name as string) || profile.name || "",
      email: (p.email as string) || "",
      phone: (p.phone as string) || "",
      location: (p.location as string) || "",
      linkedin: (p.linkedin as string) || "",
      website: (p.website as string) || "",
      summary: (p.summary as string) || "",
      experience: Array.isArray(p.experience) ? (p.experience as unknown as ResumeData["experience"]) : [],
      education: Array.isArray(p.education) ? (p.education as unknown as ResumeData["education"]) : [],
      skills: Array.isArray(p.skills) ? (p.skills as string[]) : typeof p.skills === "string" ? (p.skills as string).split(",").map((s: string) => s.trim()) : [],
    });
  }, [selectedProfile, profiles]);

  function addExperience() {
    setData({
      ...data,
      experience: [...data.experience, { company: "", title: "", startDate: "", endDate: "", description: "", location: "" }],
    });
  }

  function updateExperience(i: number, field: string, value: string) {
    const next = [...data.experience];
    next[i] = { ...next[i], [field]: value };
    setData({ ...data, experience: next });
  }

  function removeExperience(i: number) {
    setData({ ...data, experience: data.experience.filter((_, idx) => idx !== i) });
  }

  function addEducation() {
    setData({
      ...data,
      education: [...data.education, { school: "", degree: "", field: "", startDate: "", endDate: "" }],
    });
  }

  function updateEducation(i: number, field: string, value: string) {
    const next = [...data.education];
    next[i] = { ...next[i], [field]: value };
    setData({ ...data, education: next });
  }

  function removeEducation(i: number) {
    setData({ ...data, education: data.education.filter((_, idx) => idx !== i) });
  }

  function addSkill() {
    const s = skillInput.trim();
    if (s && !data.skills.includes(s)) {
      setData({ ...data, skills: [...data.skills, s] });
      setSkillInput("");
    }
  }

  function removeSkill(s: string) {
    setData({ ...data, skills: data.skills.filter((sk) => sk !== s) });
  }

  function buildPreviewQuery() {
    const params = new URLSearchParams();
    params.set("name", data.name);
    params.set("email", data.email);
    params.set("phone", data.phone);
    params.set("location", data.location);
    params.set("linkedin", data.linkedin);
    params.set("website", data.website);
    params.set("summary", data.summary);
    params.set("template", template);
    data.experience.forEach((exp, i) => {
      params.set(`exp[${i}][company]`, exp.company);
      params.set(`exp[${i}][title]`, exp.title);
      params.set(`exp[${i}][startDate]`, exp.startDate);
      params.set(`exp[${i}][endDate]`, exp.endDate);
      params.set(`exp[${i}][description]`, exp.description);
      params.set(`exp[${i}][location]`, exp.location);
    });
    data.education.forEach((edu, i) => {
      params.set(`edu[${i}][school]`, edu.school);
      params.set(`edu[${i}][degree]`, edu.degree);
      params.set(`edu[${i}][field]`, edu.field);
      params.set(`edu[${i}][startDate]`, edu.startDate);
      params.set(`edu[${i}][endDate]`, edu.endDate);
    });
    data.skills.forEach((s, i) => params.set(`skill[${i}]`, s));
    return params.toString();
  }

  async function generatePreview() {
    setLoading(true);
    try {
      const qs = buildPreviewQuery();
      const res = await fetch(`/api/sc/resume?${qs}`);
      const html = await res.text();
      setPreviewHtml(html);
      setTab("preview");
    } catch {}
    setLoading(false);
  }

  function downloadHtml() {
    if (!previewHtml) return;
    const blob = new Blob([previewHtml], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `resume-${data.name.replace(/\s+/g, "-").toLowerCase() || "draft"}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function input(label: string, value: string, onChange: (v: string) => void, opts?: { multiline?: boolean; placeholder?: string }) {
    return (
      <div>
        <label className="text-xs text-muted">{label}</label>
        {opts?.multiline ? (
          <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={opts.placeholder}
            className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm min-h-[80px]" />
        ) : (
          <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={opts?.placeholder}
            className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2"><FileText className="size-5" /> Resume Builder</h2>
          <p className="text-xs text-muted mt-0.5">Build an ATS-friendly resume from your profile data</p>
        </div>
      </div>

      {/* Profile selector + template */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="text-xs text-muted">Load from profile</label>
          <div className="flex gap-2 mt-1">
            <select value={selectedProfile} onChange={(e) => setSelectedProfile(e.target.value)}
              className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm">
              <option value="">Select profile...</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button onClick={loadFromProfile} disabled={!selectedProfile}
              className="rounded-md border border-border px-3 py-2 text-xs text-muted hover:bg-surface-hover disabled:opacity-50">
              Load
            </button>
          </div>
        </div>
        <div>
          <label className="text-xs text-muted">Template</label>
          <div className="mt-1 flex gap-1">
            {TEMPLATES.map((t) => (
              <button key={t.id} onClick={() => setTemplate(t.id)}
                className={cn("flex-1 rounded-md border px-2 py-2 text-xs transition-colors",
                  template === t.id ? "border-brand bg-brand-soft text-brand" : "border-border text-muted hover:bg-surface-hover"
                )}>
                <Palette className="inline size-3 mr-1" />
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Tab toggle */}
      <div className="flex gap-1 rounded-lg border border-border p-1 w-fit">
        <button onClick={() => setTab("edit")} className={cn("rounded-md px-3 py-1.5 text-xs font-medium", tab === "edit" ? "bg-surface text-foreground" : "text-muted")}>
          Edit
        </button>
        <button onClick={() => { generatePreview(); }} disabled={loading}
          className={cn("rounded-md px-3 py-1.5 text-xs font-medium", tab === "preview" ? "bg-surface text-foreground" : "text-muted")}>
          {loading ? <Loader2 className="inline size-3 animate-spin mr-1" /> : <Eye className="inline size-3 mr-1" />}
          Preview
        </button>
      </div>

      {tab === "edit" ? (
        <div className="space-y-5">
          {/* Contact */}
          <div className="grid gap-3 sm:grid-cols-2">
            {input("Full Name", data.name, (v) => setData({ ...data, name: v }), { placeholder: "John Doe" })}
            {input("Email", data.email, (v) => setData({ ...data, email: v }), { placeholder: "john@example.com" })}
            {input("Phone", data.phone, (v) => setData({ ...data, phone: v }), { placeholder: "+1 (555) 123-4567" })}
            {input("Location", data.location, (v) => setData({ ...data, location: v }), { placeholder: "San Francisco, CA" })}
            {input("LinkedIn", data.linkedin, (v) => setData({ ...data, linkedin: v }), { placeholder: "linkedin.com/in/johndoe" })}
            {input("Website", data.website, (v) => setData({ ...data, website: v }), { placeholder: "johndoe.com" })}
          </div>

          {input("Professional Summary", data.summary, (v) => setData({ ...data, summary: v }), { multiline: true, placeholder: "Brief overview of your experience and goals..." })}

          {/* Experience */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-foreground">Experience</h3>
              <button onClick={addExperience} className="text-xs text-brand hover:underline flex items-center gap-1"><Plus className="size-3" /> Add</button>
            </div>
            {data.experience.map((exp, i) => (
              <div key={i} className="mb-3 rounded-lg border border-border p-3 space-y-2">
                <div className="flex justify-between items-start">
                  <div className="grid gap-2 flex-1 sm:grid-cols-2">
                    {input("Title", exp.title, (v) => updateExperience(i, "title", v))}
                    {input("Company", exp.company, (v) => updateExperience(i, "company", v))}
                    {input("Start", exp.startDate, (v) => updateExperience(i, "startDate", v), { placeholder: "Jan 2024" })}
                    {input("End", exp.endDate, (v) => updateExperience(i, "endDate", v), { placeholder: "Present" })}
                  </div>
                  <button onClick={() => removeExperience(i)} className="ml-2 text-muted hover:text-red-500 mt-5"><Trash2 className="size-4" /></button>
                </div>
                {input("Description (one bullet per line)", exp.description, (v) => updateExperience(i, "description", v), { multiline: true, placeholder: "Led a team of 5 engineers\nIncreased revenue by 30%\nShipped feature X in 2 weeks" })}
              </div>
            ))}
            {data.experience.length === 0 && <p className="text-xs text-muted italic">No experience entries yet</p>}
          </div>

          {/* Education */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-foreground">Education</h3>
              <button onClick={addEducation} className="text-xs text-brand hover:underline flex items-center gap-1"><Plus className="size-3" /> Add</button>
            </div>
            {data.education.map((edu, i) => (
              <div key={i} className="mb-3 rounded-lg border border-border p-3 grid gap-2 sm:grid-cols-2">
                {input("School", edu.school, (v) => updateEducation(i, "school", v))}
                {input("Degree", edu.degree, (v) => updateEducation(i, "degree", v), { placeholder: "B.S." })}
                {input("Field", edu.field, (v) => updateEducation(i, "field", v), { placeholder: "Computer Science" })}
                {input("Start", edu.startDate, (v) => updateEducation(i, "startDate", v))}
                {input("End", edu.endDate, (v) => updateEducation(i, "endDate", v))}
                <div className="sm:col-span-2 flex justify-end">
                  <button onClick={() => removeEducation(i)} className="text-xs text-muted hover:text-red-500 flex items-center gap-1"><Trash2 className="size-3" /> Remove</button>
                </div>
              </div>
            ))}
            {data.education.length === 0 && <p className="text-xs text-muted italic">No education entries yet</p>}
          </div>

          {/* Skills */}
          <div>
            <h3 className="text-sm font-semibold text-foreground mb-2">Skills</h3>
            <div className="flex gap-2">
              <input value={skillInput} onChange={(e) => setSkillInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addSkill())}
                placeholder="Type a skill and press Enter"
                className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm" />
              <button onClick={addSkill} className="rounded-md border border-border px-3 py-2 text-xs text-muted hover:bg-surface-hover">Add</button>
            </div>
            {data.skills.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {data.skills.map((s) => (
                  <span key={s} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs">
                    {s}
                    <button onClick={() => removeSkill(s)} className="text-muted hover:text-foreground">&times;</button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Preview */
        <div className="rounded-lg border border-border bg-white">
          {previewHtml ? (
            <iframe srcDoc={previewHtml} className="w-full min-h-[600px] rounded-lg" title="Resume Preview" />
          ) : (
            <div className="flex items-center justify-center h-64 text-sm text-muted">
              {loading ? <Loader2 className="size-5 animate-spin" /> : "Click Preview to generate"}
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      {tab === "preview" && previewHtml && (
        <div className="flex gap-2">
          <button onClick={downloadHtml}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:bg-brand-200">
            <Download className="size-4" /> Download HTML
          </button>
          <button onClick={() => { const w = window.open("", "_blank"); w?.document.write(previewHtml); w?.document.close(); }}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-4 py-2 text-sm text-muted hover:bg-surface-hover">
            <Mail className="size-4" /> Open in new tab (print to PDF)
          </button>
        </div>
      )}
    </div>
  );
}
