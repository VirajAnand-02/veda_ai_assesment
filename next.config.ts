import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only: keep the Next.js badge from covering the collapsed sidebar's expand button.
  devIndicators: { position: "bottom-right" },
};

export default nextConfig;
