import Image from "next/image";

type BackgroundGlowProps = {
  variant: "upload" | "app";
};

// Soft blurred ellipses behind the desktop layout. The SVGs already include
// their blur bleed, so they are placed at their natural size, centred on the
// ellipse position from the design, and clipped by the shell.
export function BackgroundGlow({ variant }: BackgroundGlowProps) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 hidden overflow-hidden lg:block"
    >
      {variant === "upload" ? (
        <Image
          src="/assets/glow/glow-upload-bottom.svg"
          alt=""
          width={2118}
          height={1228}
          className="absolute bottom-[-720px] left-[calc(50%+166px)] max-w-none -translate-x-1/2"
        />
      ) : (
        <>
          <Image
            src="/assets/glow/glow-app-bottom.svg"
            alt=""
            width={2118}
            height={1228}
            className="absolute bottom-[-614px] left-[calc(50%+61px)] max-w-none -translate-x-1/2"
          />
          <Image
            src="/assets/glow/glow-app-top.svg"
            alt=""
            width={1913}
            height={1228}
            className="absolute top-[-614px] left-[calc(50%+163.5px)] max-w-none -translate-x-1/2"
          />
        </>
      )}
    </div>
  );
}
