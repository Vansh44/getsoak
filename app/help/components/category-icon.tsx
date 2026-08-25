import {
  Rocket,
  LayoutTemplate,
  Package,
  IndianRupee,
  Globe,
  Truck,
  Megaphone,
  CreditCard,
  ChartNoAxesCombined,
  ScanLine,
  BookOpen,
  type LucideIcon,
} from "lucide-react";

// Fixed catalog so a stored icon name resolves to a real component (no dynamic
// import). Unknown names fall back to a book. Keep in sync with the category
// seeds/migrations + the icon picker in the console category form.
const ICONS: Record<string, LucideIcon> = {
  Rocket,
  LayoutTemplate,
  Package,
  IndianRupee,
  Globe,
  Truck,
  Megaphone,
  CreditCard,
  ChartNoAxesCombined,
  ScanLine,
  BookOpen,
};

export const HELP_ICON_NAMES = Object.keys(ICONS);

export function CategoryIcon({
  name,
  size = 22,
}: {
  name: string | null;
  size?: number;
}) {
  const Icon = (name && ICONS[name]) || BookOpen;
  return <Icon size={size} aria-hidden />;
}
