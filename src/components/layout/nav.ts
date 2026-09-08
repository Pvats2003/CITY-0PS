import {
  LayoutDashboard,
  CalendarClock,
  Store,
  Users,
  Cpu,
  Radio,
  AlertTriangle,
  ShieldCheck,
  FileText,
  BarChart3,
  Search,
} from "lucide-react";

export const NAV_ITEMS = [
  { to: "/", label: "Command Center", icon: LayoutDashboard, end: true },
  { to: "/today", label: "Today", icon: CalendarClock },
  { to: "/businesses", label: "Businesses", icon: Store },
  { to: "/field-officers", label: "Field Officers", icon: Users },
  { to: "/fleet", label: "Fleet", icon: Cpu },
  { to: "/sessions", label: "Sessions", icon: Radio },
  { to: "/issues", label: "Issues", icon: AlertTriangle },
  { to: "/quality", label: "Quality", icon: ShieldCheck },
  { to: "/reports", label: "Reports", icon: FileText },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/search", label: "Search", icon: Search },
] as const;
