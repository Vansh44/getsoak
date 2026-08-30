import { Bot } from "lucide-react";

export function MinkMark({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const box =
    size === "sm"
      ? "h-7 w-7 rounded-lg"
      : size === "lg"
        ? "h-11 w-11 rounded-[14px]"
        : "h-9 w-9 rounded-xl";
  const icon =
    size === "sm" ? "h-4 w-4" : size === "lg" ? "h-6 w-6" : "h-5 w-5";

  return (
    <span
      aria-hidden="true"
      className={`${box} relative inline-flex shrink-0 items-center justify-center bg-[#6d4dff] text-white shadow-[0_7px_18px_rgba(109,77,255,0.24)]`}
    >
      <Bot className={icon} strokeWidth={2.25} />
    </span>
  );
}
