import type { Metadata } from "next";
import type { ReactNode } from "react";

import { resolveMetadataBase } from "@/lib/site-url";

import "./globals.css";

export const metadata: Metadata = {
  metadataBase: resolveMetadataBase(process.env.VERCEL_PROJECT_PRODUCTION_URL),
  title: "Date Stamp Cleaner",
  description:
    "Remove orange camera date stamps privately. Every photo is processed on your device.",
  applicationName: "Date Stamp Cleaner",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    title: "Date Stamp Cleaner",
    description: "Remove orange camera date stamps privately. Your photos never leave your device.",
    images: [{ url: "/og.png", width: 1734, height: 907, alt: "Date Stamp Cleaner" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Date Stamp Cleaner",
    description: "Remove orange camera date stamps privately. Your photos never leave your device.",
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
