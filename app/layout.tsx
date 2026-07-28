import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Thor — autonomous AI co-founder",
  description:
    "A voice-first cockpit for a workforce of specialist agents that learns, runs, and scales a solo business.",
};

export const viewport: Viewport = {
  themeColor: "#04070a",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="field-vignette h-full">{children}</body>
    </html>
  );
}
