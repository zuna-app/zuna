import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Zuna - Self-Hosted End-to-End Encrypted Chat",
  description:
    "Zuna is a fully self-hosted, end-to-end encrypted messaging platform. Own your server, own your data. X25519 key exchange, AES-256-GCM encryption, Ed25519 signatures.",
  keywords: [
    "encrypted chat",
    "self-hosted chat",
    "E2EE",
    "privacy",
    "secure messaging",
    "end-to-end encryption",
    "open source chat",
    "zero knowledge",
  ],
  openGraph: {
    title: "Zuna - Self-Hosted E2EE Chat",
    description:
      "Your server. Your keys. Your data. Zuna is a privacy-first, open-source messaging platform with end-to-end encryption and voice/video calls.",
    type: "website",
    siteName: "Zuna",
  },
  twitter: {
    card: "summary_large_image",
    title: "Zuna - Self-Hosted E2EE Chat",
    description:
      "Your server. Your keys. Your data. Open source messaging with end-to-end encryption.",
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body
        className="font-sans antialiased min-h-screen"
        style={{ backgroundColor: "#060d1a", color: "#f1f5f9" }}
      >
        {children}
      </body>
    </html>
  );
}
