import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { BackgroundGlow } from "./background-glow";
import { MobileHeader } from "./mobile-header";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

export type ShellVariant = "upload" | "loading" | "mapping";

// Backgrounds differ per screen and per breakpoint in the design.
const BACKGROUNDS: Record<ShellVariant, string> = {
  upload: "bg-linear-to-b from-[#eee] to-[#dadada] lg:from-[#f5f5f5] lg:to-[#e9e5e5]",
  loading: "bg-linear-to-b from-[#eee] to-[#dadada]",
  mapping: "bg-[#cecece] lg:bg-linear-to-b lg:from-[#eee] lg:to-[#dadada]",
};

type AppShellProps = {
  variant: ShellVariant;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onBack?: () => void;
  children: ReactNode;
};

export function AppShell({
  variant,
  sidebarCollapsed,
  onToggleSidebar,
  onBack,
  children,
}: AppShellProps) {
  return (
    <div
      className={cn(
        "relative flex min-h-dvh flex-col overflow-x-clip lg:h-dvh lg:flex-row lg:gap-3 lg:overflow-hidden lg:p-3",
        BACKGROUNDS[variant],
      )}
    >
      <BackgroundGlow variant={variant === "upload" ? "upload" : "app"} />
      <Sidebar collapsed={sidebarCollapsed} onToggle={onToggleSidebar} />
      <div className="relative flex min-w-0 flex-1 flex-col gap-3 p-2.5 lg:min-h-0 lg:p-0">
        <TopBar onBack={onBack} />
        <MobileHeader onBack={onBack} />
        <main className="flex min-h-0 flex-1 flex-col">{children}</main>
      </div>
    </div>
  );
}
