import { Home, Briefcase, FileCheck, Users, Settings } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

// Single source of truth for the app's primary destinations — shared by the
// desktop sidebar and the mobile nav so they can never drift.
export type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  chip?: string;
};

// Primary navigation — four items only. Everything else is secondary.
export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Home", icon: Home },
  { href: "/jobs", label: "Jobs", icon: Briefcase },
  { href: "/applications", label: "Applications", icon: FileCheck },
  { href: "/profiles", label: "Profiles", icon: Users },
];

// Secondary navigation — accessible but not in the primary sidebar.
export const SECONDARY_NAV_ITEMS: NavItem[] = [
  { href: "/saved", label: "Saved", icon: Settings },
  { href: "/config", label: "Settings", icon: Settings },
];

export function isActivePath(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}
