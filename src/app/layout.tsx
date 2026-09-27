import type { Metadata } from "next";
import { Bricolage_Grotesque, Inter } from "next/font/google";
import "./globals.css";

const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
  axes: ["opsz", "wdth"],
});

// Only used for the "AI Teacher's Toolkit" button label.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: "500",
});

export const metadata: Metadata = {
  title: "VedaAI",
  description: "Upload a question paper and answer sheets, then map answers to questions.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${bricolage.variable} ${inter.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
