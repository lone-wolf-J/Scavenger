import { InterviewCalendar } from "@/components/calendar/interview-calendar";

export const dynamic = "force-dynamic";

export default function CalendarPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <InterviewCalendar />
    </div>
  );
}
