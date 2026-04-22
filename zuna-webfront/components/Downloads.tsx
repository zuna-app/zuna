"use client";

import { motion } from "framer-motion";
import {
  Monitor,
  Apple,
  Smartphone,
  Download,
  ExternalLink,
} from "lucide-react";

const platforms = [
  {
    icon: Monitor,
    iconBg: "bg-blue-500/15",
    iconColor: "text-blue-400",
    label: "Windows",
    sublabel: "Windows 10+",
    format: ".exe installer",
    disabled: false,
    href: "https://github.com/zuna-app/zuna/releases/latest",
  },
  {
    icon: Apple,
    iconBg: "bg-slate-400/15",
    iconColor: "text-slate-300",
    label: "macOS",
    sublabel: "macOS 12+",
    format: ".dmg package",
    disabled: false,
    href: "https://github.com/zuna-app/zuna/releases/latest",
  },
  {
    icon: Monitor,
    iconBg: "bg-orange-500/15",
    iconColor: "text-orange-400",
    label: "Linux",
    sublabel: "Ubuntu, Fedora & more",
    format: ".deb · .rpm · AppImage",
    disabled: false,
    href: "https://github.com/zuna-app/zuna/releases/latest",
  },
  {
    icon: Smartphone,
    iconBg: "bg-zinc-500/15",
    iconColor: "text-zinc-300",
    label: "iOS",
    sublabel: "Coming soon",
    format: "N/A",
    disabled: true,
    href: "",
  },
  {
    icon: Smartphone,
    iconBg: "bg-lime-500/15",
    iconColor: "text-lime-400",
    label: "Android",
    sublabel: "Coming soon",
    format: "N/A",
    disabled: true,
    href: "",
  },
];

export default function Downloads() {
  return (
    <section id="downloads" className="py-32 relative">
      <div className="absolute top-0 inset-x-0 h-px bg-linear-to-r from-transparent via-border to-transparent pointer-events-none" />

      <div className="container mx-auto px-6 max-w-7xl">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <div className="inline-flex items-center gap-2 bg-accent/10 border border-accent/25 rounded-full px-4 py-1.5 text-sm text-accent-glow mb-6">
            <Download className="w-3.5 h-3.5" />
            Download
          </div>
          <h2 className="text-4xl lg:text-5xl font-bold text-white mb-5">
            Your platform, <span className="gradient-text">your choice.</span>
          </h2>
          <p className="text-slate-400 text-lg max-w-xl mx-auto">
            Zuna runs natively on Windows, macOS, and Linux, with iOS and
            Android support on the way.
          </p>
        </motion.div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-5 mb-10">
          {platforms.map((platform, i) => {
            const Icon = platform.icon;
            return (
              <motion.a
                key={platform.label}
                href={platform.disabled ? undefined : platform.href}
                target={platform.disabled ? undefined : "_blank"}
                rel={platform.disabled ? undefined : "noopener noreferrer"}
                aria-disabled={platform.disabled}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.5, delay: i * 0.1 }}
                whileHover={
                  platform.disabled ? undefined : { y: -5, scale: 1.02 }
                }
                whileTap={platform.disabled ? undefined : { scale: 0.98 }}
                className={`group relative bg-bg-card border rounded-2xl p-6 transition-all duration-300 flex flex-col items-center text-center gap-4 ${
                  platform.disabled
                    ? "border-border opacity-60 cursor-not-allowed"
                    : "border-border hover:border-border-light cursor-pointer"
                }`}
              >
                <div
                  className={`w-14 h-14 ${platform.iconBg} rounded-2xl flex items-center justify-center transition-transform duration-300 group-hover:scale-110`}
                >
                  <Icon className={`w-7 h-7 ${platform.iconColor}`} />
                </div>
                <div>
                  <div className="text-white font-semibold text-lg mb-0.5">
                    {platform.label}
                  </div>
                  <div className="text-slate-500 text-xs mb-3">
                    {platform.sublabel}
                  </div>
                  <div className="text-slate-400 text-xs font-mono bg-bg-elevated border border-border px-2.5 py-1 rounded-lg inline-block">
                    {platform.format}
                  </div>
                </div>
                <div
                  className={`flex items-center gap-1.5 text-sm font-semibold mt-auto ${
                    platform.disabled
                      ? "text-slate-500"
                      : "text-slate-400 group-hover:text-white"
                  } transition-colors`}
                >
                  <Download className="w-4 h-4" />
                  {platform.disabled ? "Coming soon" : "Download"}
                </div>
              </motion.a>
            );
          })}
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="flex items-center justify-center gap-2 text-slate-500 text-sm"
        >
          <span>All releases on</span>
          <a
            href="https://github.com/zuna-app/zuna/releases"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-accent-glow hover:text-white transition-colors font-medium"
          >
            GitHub Releases
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </motion.div>
      </div>
    </section>
  );
}
