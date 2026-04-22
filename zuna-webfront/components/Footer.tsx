"use client";

import { motion } from "framer-motion";
import Image from "next/image";
import { Github, ExternalLink } from "lucide-react";

const footerLinks = [
  {
    title: "Product",
    links: [
      { label: "Features", href: "#features" },
      { label: "How It Works", href: "#how-it-works" },
      { label: "Downloads", href: "#downloads" },
      { label: "Self-Host", href: "#self-host" },
    ],
  },
  {
    title: "Resources",
    links: [
      {
        label: "GitHub",
        href: "https://github.com/zuna-app/zuna",
        external: true,
      },
      {
        label: "Releases",
        href: "https://github.com/zuna-app/zuna/releases",
        external: true,
      },
      {
        label: "Issues",
        href: "https://github.com/zuna-app/zuna/issues",
        external: true,
      },
      {
        label: "License (AGPL-3.0)",
        href: "https://github.com/zuna-app/zuna/blob/main/LICENSE",
        external: true,
      },
    ],
  },
];

export default function Footer() {
  return (
    <footer className="relative border-t border-border">
      <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-border-light to-transparent pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6 }}
        className="relative overflow-hidden"
        style={{
          background:
            "linear-gradient(to right, rgba(37,99,235,0.08), rgba(99,102,241,0.06), rgba(124,58,237,0.04))",
        }}
      >
        <div className="container mx-auto px-6 py-16 max-w-7xl text-center relative z-10">
          <h2 className="text-3xl lg:text-4xl font-bold text-white mb-4">
            Ready to own your{" "}
            <span className="gradient-text">conversations?</span>
          </h2>
          <p className="text-slate-400 mb-8 max-w-lg mx-auto">
            Deploy Zuna in minutes. No telemetry, no third-party servers, no
            compromises.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <motion.a
              href="#downloads"
              whileHover={{
                scale: 1.03,
                boxShadow: "0 0 30px rgba(37,99,235,0.4)",
              }}
              whileTap={{ scale: 0.97 }}
              className="bg-accent hover:bg-accent-light text-white font-semibold px-7 py-3 rounded-xl transition-colors"
            >
              Download Zuna
            </motion.a>
            <motion.a
              href="https://github.com/zuna-app/zuna"
              target="_blank"
              rel="noopener noreferrer"
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              className="flex items-center gap-2 bg-bg-card border border-border hover:border-border-light text-slate-200 font-semibold px-7 py-3 rounded-xl transition-colors"
            >
              <Github className="w-4 h-4" />
              View on GitHub
            </motion.a>
          </div>
        </div>
      </motion.div>

      <div className="container mx-auto px-6 py-12 max-w-7xl border-t border-border">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-12">
          <div className="col-span-2">
            <a href="#" className="flex items-center gap-2.5 mb-4">
              <Image
                src="/zuna.png"
                alt="Zuna"
                width={32}
                height={32}
                className="rounded-lg"
              />
              <span className="text-white font-bold text-lg">Zuna</span>
            </a>
            <p className="text-slate-500 text-sm leading-relaxed max-w-xs">
              A fully self-hosted, end-to-end encrypted messaging platform built
              for privacy-conscious individuals and teams.
            </p>
          </div>

          {footerLinks.map((group) => (
            <div key={group.title}>
              <div className="text-white text-sm font-semibold mb-4">
                {group.title}
              </div>
              <ul className="space-y-2.5">
                {group.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      target={
                        "external" in link && link.external
                          ? "_blank"
                          : undefined
                      }
                      rel={
                        "external" in link && link.external
                          ? "noopener noreferrer"
                          : undefined
                      }
                      className="flex items-center gap-1.5 text-slate-500 hover:text-white text-sm transition-colors"
                    >
                      {link.label}
                      {"external" in link && link.external && (
                        <ExternalLink className="w-3 h-3 opacity-50" />
                      )}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-8 border-t border-border">
          <p className="text-slate-600 text-sm">
            © {new Date().getFullYear()} Zuna. Released under{" "}
            <a
              href="https://github.com/zuna-app/zuna/blob/main/LICENSE"
              target="_blank"
              rel="noopener noreferrer"
              className="text-slate-500 hover:text-white transition-colors"
            >
              AGPL-3.0
            </a>
            .
          </p>
          <div className="flex items-center gap-1.5 text-slate-600 text-sm">
            <Image
              src="/zuna.png"
              alt="Zuna"
              width={14}
              height={14}
              className="rounded-sm opacity-80"
            />
            <span>Privacy by design</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
