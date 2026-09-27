import Image from "next/image";
import { ArrowLeft, Menu } from "lucide-react";

type MobileHeaderProps = {
  onBack?: () => void;
};

// Phone-width header. From the `lg` breakpoint up <TopBar /> takes over.
export function MobileHeader({ onBack }: MobileHeaderProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between rounded-2xl bg-white pr-4 pl-3 lg:hidden">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} aria-label="Back" className="text-ink active:scale-90">
          <ArrowLeft size={24} />
        </button>
        <Image src="/assets/brand/logo-mobile.svg" alt="" width={28} height={28} />
        <span className="text-[20px] leading-[1.4] font-bold tracking-[-1.2px] text-ink">
          VedaAI
        </span>
      </div>

      <div className="flex items-center justify-end gap-3">
        <button type="button" aria-label="Notifications" className="shrink-0 active:scale-90">
          <Image src="/assets/icons/bell-mobile.svg" alt="" width={36} height={36} />
        </button>
        <Image
          src="/assets/images/avatar.jpg"
          alt="Viraj Anand"
          width={32}
          height={32}
          className="size-8 rounded-full bg-off-white object-cover"
        />
        <button type="button" aria-label="Menu" className="text-ink active:scale-90">
          <Menu size={24} />
        </button>
      </div>
    </header>
  );
}
