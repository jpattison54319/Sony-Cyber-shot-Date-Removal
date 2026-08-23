import type { Metadata } from "next";
import type { ReactNode } from "react";

import { resolveMetadataBase } from "@/lib/site-url";

import "./globals.css";

export const metadata: Metadata = {
  metadataBase: resolveMetadataBase(process.env.VERCEL_PROJECT_PRODUCTION_URL),
  title: "Date Stamp Cleaner",
  description:
    "Download the private desktop app for removing Sony Cyber-shot date stamps on macOS and Windows.",
  applicationName: "Date Stamp Cleaner",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    title: "Date Stamp Cleaner",
    description: "The validated local date-removal workflow for macOS and Windows.",
    images: [{ url: "/og.png", width: 1734, height: 907, alt: "Date Stamp Cleaner" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Date Stamp Cleaner",
    description: "The validated local date-removal workflow for macOS and Windows.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
