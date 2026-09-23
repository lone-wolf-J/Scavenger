"use client";

import { useState } from "react";
import { FileText, Mail } from "lucide-react";
import { ResumeBuilder } from "@/components/resume/resume-builder";
import { CoverLetterBuilder } from "@/components/resume/cover-letter-builder";
import { cn } from "@/lib/cn";

type Tab = "resume" | "cover-letter";

export default function ResumePage() {
  const [tab, setTab] = useState<Tab>("resume");

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold text-foreground">Documents</h1>
      </div>

      <div className="flex gap-1 rounded-lg border border-border p-1 mb-6 w-fit">
        <button onClick={() => setTab("resume")}
          className={cn("rounded-md px-4 py-2 text-sm font-medium transition-colors",
            tab === "resume" ? "bg-surface text-foreground" : "text-muted hover:bg-surface-hover"
          )}>
          <FileText className="inline size-4 mr-1.5" /> Resume
        </button>
        <button onClick={() => setTab("cover-letter")}
          className={cn("rounded-md px-4 py-2 text-sm font-medium transition-colors",
            tab === "cover-letter" ? "bg-surface text-foreground" : "text-muted hover:bg-surface-hover"
          )}>
          <Mail className="inline size-4 mr-1.5" /> Cover Letter
        </button>
      </div>

      {tab === "resume" ? <ResumeBuilder /> : <CoverLetterBuilder />}
    </div>
  );
}
