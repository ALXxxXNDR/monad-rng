import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE_TITLE = "Monad RND · Public randomness for Monad";
const SITE_DESCRIPTION =
  "Public randomness infrastructure with zero protocol fees: deploy an isolated Monad instance, lock Tx1, authenticate three headers, and store Tx2 forever.";

const sharedMetadata: Metadata = {
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  applicationName: "Monad RND",
  keywords: [
    "Monad",
    "randomness",
    "block entropy",
    "smart contract",
    "public good",
  ],
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

function firstHeaderValue(value: string | null): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

function requestOrigin(requestHeaders: Awaited<ReturnType<typeof headers>>): URL {
  const host =
    firstHeaderValue(requestHeaders.get("x-forwarded-host")) ??
    firstHeaderValue(requestHeaders.get("host"));
  const forwardedProtocol = firstHeaderValue(
    requestHeaders.get("x-forwarded-proto"),
  )?.toLowerCase();
  const protocol =
    forwardedProtocol === "http" || forwardedProtocol === "https"
      ? forwardedProtocol
      : host?.startsWith("localhost")
        ? "http"
        : "https";

  if (host && /^[a-z0-9.-]+(?::[0-9]+)?$/i.test(host)) {
    try {
      return new URL(`${protocol}://${host}`);
    } catch {
      // Fall through to a local build-safe origin.
    }
  }
  return new URL("http://localhost:3000");
}

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const origin = requestOrigin(requestHeaders);
  const socialImage = new URL("/og.png", origin);

  return {
    ...sharedMetadata,
    metadataBase: origin,
    alternates: {
      canonical: origin,
    },
    openGraph: {
      type: "website",
      url: origin,
      siteName: "Monad RND",
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
      images: [
        {
          url: socialImage,
          width: 1_731,
          height: 909,
          alt: "Monad RND public randomness for Monad",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
