import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Morpheus — NYX Core",
  description:
    "A voice-first cockpit for a workforce of specialist agents that learns, runs, and scales a solo business. Built by NYX Core.",
  applicationName: "Morpheus",
};

export const viewport: Viewport = {
  themeColor: "#060b16",
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
