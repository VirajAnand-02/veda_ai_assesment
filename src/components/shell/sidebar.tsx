import Image from "next/image";
import { ChevronsRight } from "lucide-react";
import { cn } from "@/lib/cn";

type NavItem = {
  label: string;
  icon: string;
  width: number;
  height: number;
  active?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { label: "Home", icon: "/assets/icons/nav-home.svg", width: 20, height: 20 },
  { label: "My Classroom", icon: "/assets/icons/nav-classroom.svg", width: 20, height: 14 },
  { label: "Assignments", icon: "/assets/icons/nav-assignments.svg", width: 20, height: 20 },
  { label: "Exams", icon: "/assets/icons/nav-exams.svg", width: 20, height: 20, active: true },
  { label: "My Library", icon: "/assets/icons/nav-library.svg", width: 20, height: 20 },
];

// The design shows only the crest of a wide school-logo banner: the banner is
// scaled up inside a fixed box and clipped, so it is reproduced the same way.
function SchoolCrest({ className }: { className: string }) {
  return (
    <div className={cn("relative shrink-0 overflow-hidden", className)}>
      <Image
        src="/assets/images/school-logo.png"
        alt="Delhi Public School crest"
        width={2208}
        height={495}
        className="absolute max-w-none"
        style={{ left: "0.38%", top: "-2.18%", width: "538.54%", height: "106.67%" }}
      />
    </div>
  );
}

const toolkitRing =
  "relative flex items-center justify-center rounded-full border-4 border-[#ff7950] bg-[#272727] " +
  "after:pointer-events-none after:absolute after:inset-[-4px] after:rounded-[inherit] " +
  "after:shadow-[inset_0_-1px_3.5px_rgba(177,177,177,0.6),inset_0_0_34.5px_rgba(255,255,255,0.25)]";

type SidebarProps = {
  collapsed: boolean;
  onToggle: () => void;
};

// Nav buttons nudge their icon on hover.
const navIcon = "transition-transform duration-200 group-hover:scale-110";

// One panel whose width animates between the two layouts; the layouts are
// stacked inside it and cross-fade. Each keeps its own fixed width, so nothing
// reflows while the panel resizes.
export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  return (
    <aside
      aria-label="Main navigation"
      className={cn(
        "relative hidden shrink-0 overflow-hidden rounded-2xl bg-white shadow-panel lg:block",
        "transition-[width] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none",
        collapsed ? "w-16" : "w-[304px]",
      )}
    >
      <div
        inert={collapsed}
        className={cn(
          "absolute inset-y-0 left-0 flex w-[304px] transition-opacity duration-200",
          collapsed ? "pointer-events-none opacity-0" : "opacity-100 delay-100",
        )}
      >
        <ExpandedNav onToggle={onToggle} />
      </div>
      <div
        inert={!collapsed}
        className={cn(
          "absolute inset-y-0 left-0 flex w-16 transition-opacity duration-200",
          collapsed ? "opacity-100 delay-150" : "pointer-events-none opacity-0",
        )}
      >
        <CollapsedNav onToggle={onToggle} />
      </div>
    </aside>
  );
}

function CollapsedNav({ onToggle }: { onToggle: () => void }) {
  return (
    <div className="flex w-full flex-col items-center justify-between py-3">
      <div className="flex flex-col items-center gap-14">
        <Image src="/assets/brand/logo.svg" alt="VedaAI" width={40} height={40} />
        <button
          type="button"
          aria-label="AI Teacher's Toolkit"
          className={cn(toolkitRing, "size-11 hover:scale-105 hover:brightness-110 active:scale-95")}
        >
          <Image
            src="/assets/icons/toolkit-sparkle-collapsed.svg"
            alt=""
            width={18.3162}
            height={17.3162}
          />
        </button>
        <nav aria-label="Sections" className="flex flex-col items-center gap-2">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.label}
              type="button"
              aria-label={item.label}
              aria-current={item.active ? "page" : undefined}
              className={cn(
                "group flex h-[38px] w-10 items-center justify-center rounded-lg active:scale-95",
                item.active ? "bg-off-white-20" : "hover:bg-off-white",
              )}
            >
              <Image src={item.icon} alt="" width={item.width} height={item.height} className={navIcon} />
            </button>
          ))}
        </nav>
      </div>

      <div className="flex flex-col items-center gap-2">
        <div className="rounded-[11.52px] bg-off-white-20 p-0.5">
          <SchoolCrest className="h-[43.2px] w-[42.48px]" />
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-label="Expand sidebar"
          className="group flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:bg-off-white hover:text-ink"
        >
          <ChevronsRight size={20} className="transition-transform duration-200 group-hover:translate-x-0.5" />
        </button>
      </div>
    </div>
  );
}

function ExpandedNav({ onToggle }: { onToggle: () => void }) {
  return (
    <div className="flex w-full flex-col items-center justify-between p-6">
      <div className="flex w-full flex-col items-center gap-14">
        <div className="flex w-full items-center justify-between">
          <div className="flex items-center gap-2">
            <Image src="/assets/brand/logo.svg" alt="" width={40} height={40} />
            <span className="text-[28px] leading-none font-bold tracking-[-1.68px] whitespace-nowrap text-ink">
              VedaAI
            </span>
          </div>
          <button
            type="button"
            onClick={onToggle}
            aria-label="Collapse sidebar"
            className="flex size-9 items-center justify-center rounded-lg hover:bg-off-white active:scale-95"
          >
            <Image src="/assets/icons/sidebar-toggle.svg" alt="" width={20} height={20} />
          </button>
        </div>

        <button
          type="button"
          className={cn(
            toolkitRing,
            "group h-[42px] w-full gap-2.5 px-4 font-inter text-[16px] leading-7 font-medium tracking-[-0.64px] whitespace-nowrap text-white",
            "hover:-translate-y-0.5 hover:shadow-[0_8px_18px_rgba(255,121,80,0.35)] active:translate-y-0 active:scale-[0.98]",
          )}
        >
          <Image
            src="/assets/icons/toolkit-sparkle.svg"
            alt=""
            width={18.3162}
            height={17.3162}
            className="transition-transform duration-300 group-hover:rotate-[20deg] group-hover:scale-110"
          />
          AI Teacher’s Toolkit
        </button>

        <nav aria-label="Sections" className="flex w-full flex-col gap-2">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.label}
              type="button"
              aria-current={item.active ? "page" : undefined}
              className={cn(
                "group flex w-full items-center gap-2 rounded-lg px-3 text-left text-[16px] tracking-[-0.64px] active:scale-[0.98]",
                item.active
                  ? "h-10 bg-off-white-20 font-medium text-ink"
                  : "h-[38px] font-normal text-muted/80 hover:bg-off-white hover:text-ink",
              )}
            >
              <Image src={item.icon} alt="" width={item.width} height={item.height} className={navIcon} />
              <span className="min-w-0 flex-1 truncate leading-[1.4] transition-transform duration-200 group-hover:translate-x-0.5">
                {item.label}
              </span>
            </button>
          ))}
        </nav>
      </div>

      <div className="flex w-full items-center gap-2 rounded-2xl bg-off-white-20 p-3">
        <SchoolCrest className="h-[60px] w-[59px]" />
        <div className="min-w-0 flex-1 whitespace-nowrap">
          <p className="truncate text-[16px] leading-[1.4] font-bold tracking-[-0.64px] text-ink">
            Delhi Public School
          </p>
          <p className="truncate text-[14px] leading-[1.4] tracking-[-0.56px] text-muted">
            Bokaro Steel City
          </p>
        </div>
      </div>
    </div>
  );
}
