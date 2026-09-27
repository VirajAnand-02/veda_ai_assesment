import Image from "next/image";
import { ChevronDown } from "lucide-react";

type TopBarProps = {
  onBack?: () => void;
};

const USER_NAME = "Viraj Anand";

// Round icon buttons grow a little on hover and dip when pressed.
const iconButton = "shrink-0 rounded-full hover:scale-110 active:scale-95";

// Desktop top bar. Below the `lg` breakpoint <MobileHeader /> is used instead.
export function TopBar({ onBack }: TopBarProps) {
  return (
    <header className="hidden h-14 shrink-0 items-center gap-2.5 rounded-2xl bg-white/75 pr-2 pl-6 lg:flex">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back"
        className="group flex size-10 shrink-0 items-center justify-center rounded-full bg-white hover:shadow-[0_4px_12px_rgba(0,0,0,0.12)] active:scale-95"
      >
        <Image
          src="/assets/icons/arrow-left.svg"
          alt=""
          width={24}
          height={24}
          className="transition-transform duration-200 group-hover:-translate-x-0.5"
        />
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Image src="/assets/icons/clipboard.svg" alt="" width={20} height={20} />
        <span className="truncate text-[16px] font-semibold tracking-[-0.64px] text-disabled">
          Exams
        </span>
      </div>

      <button
        type="button"
        aria-label="Help"
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-off-white hover:scale-110 hover:bg-white active:scale-95"
      >
        <span
          aria-hidden
          className="flex size-6 items-center justify-center rounded-full border-2 border-ink text-[16px] leading-none font-bold text-ink"
        >
          ?
        </span>
      </button>
      <button type="button" aria-label="Notifications" className={iconButton}>
        <Image src="/assets/icons/bell.svg" alt="" width={36} height={36} />
      </button>
      <button type="button" aria-label="AI assistant" className={iconButton}>
        <Image src="/assets/icons/sparkle.svg" alt="" width={36} height={36} />
      </button>

      <button
        type="button"
        className="group flex shrink-0 items-center gap-2 rounded-xl px-3 py-1.5 hover:bg-white active:scale-[0.98]"
      >
        <Image
          src="/assets/images/avatar.jpg"
          alt=""
          width={32}
          height={32}
          className="size-8 rounded-full bg-off-white object-cover"
        />
        <span className="flex items-center gap-1 text-[16px] font-semibold tracking-[-0.64px] whitespace-nowrap text-ink">
          {USER_NAME}
          <ChevronDown size={16} aria-hidden className="transition-transform duration-200 group-hover:translate-y-0.5" />
        </span>
      </button>
    </header>
  );
}
