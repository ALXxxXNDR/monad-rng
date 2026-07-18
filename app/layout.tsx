import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Monad RND · Public randomness for Monad",
  description:
    "Public randomness infrastructure with zero protocol fees: deploy an isolated Monad instance, lock Tx1, authenticate three headers, and store Tx2 forever.",
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
