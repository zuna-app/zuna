"use client";

import { motion } from "framer-motion";
import { Lock, Server, Phone, Paperclip, Zap, Github } from "lucide-react";

const features = [
  {
    icon: Lock,
    iconBg: "bg-blue-500/15",
    iconColor: "text-blue-400",
    title: "End-to-End Encrypted",
    description:
      "Every message is encrypted with AES-256-GCM before leaving your device. X25519 Diffie-Hellman for key exchange, Ed25519 for authentication. The server stores only ciphertext.",
    tag: "AES-256-GCM",
  },
  {
    icon: Server,
    iconBg: "bg-indigo-500/15",
    iconColor: "text-indigo-400",
    title: "Fully Self-Hosted",
    description:
      "Your infrastructure, your rules. Deploy on any Linux server with Docker Compose. Supports SQLite for lightweight setups and MariaDB for production scale.",
    tag: "Docker Ready",
  },
  {
    icon: Phone,
    iconBg: "bg-violet-500/15",
    iconColor: "text-violet-400",
    title: "Voice & Video Calls",
    description:
      "Crystal-clear encrypted group calls and screen sharing powered by LiveKit WebRTC — the same open-source engine trusted by major platforms. No telemetry.",
    tag: "LiveKit WebRTC",
  },
  {
    icon: Paperclip,
    iconBg: "bg-cyan-500/15",
    iconColor: "text-cyan-400",
    title: "Encrypted File Sharing",
    description:
      "Share files up to 512 MB with full end-to-end encryption. Even filenames are encrypted client-side — the server has no idea what you're sending.",
    tag: "Up to 512 MB",
  },
  {
    icon: Zap,
    iconBg: "bg-amber-500/15",
    iconColor: "text-amber-400",
    title: "Real-Time & Rich",
    description:
      "WebSocket-powered instant delivery with typing indicators, read receipts, online presence, and 7TV animated emote support for a chat that feels alive.",
    tag: "WebSocket",
  },
  {
    icon: Github,
    iconBg: "bg-slate-500/15",
    iconColor: "text-slate-300",
    title: "Fully Open Source",
    description:
      "Licensed under AGPL-3.0. Every line of code is auditable on GitHub. Trust through transparency — not promises. Fork it, extend it, make it yours.",
    tag: "AGPL-3.0",
  },
];

export default function Features() {
  return (
    <section id="features" className="py-32 relative">
      <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-border to-transparent pointer-events-none" />
      <div className="absolute bottom-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-border to-transparent pointer-events-none" />

      <div className="container mx-auto px-6 max-w-7xl">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-20"
        >
          <div className="inline-flex items-center gap-2 bg-accent/10 border border-accent/25 rounded-full px-4 py-1.5 text-sm text-accent-glow mb-6">
            <Lock className="w-3.5 h-3.5" />
            Built for Privacy
          </div>
          <h2 className="text-4xl lg:text-5xl font-bold text-white mb-5">
            Everything you need,{" "}
            <span className="gradient-text">nothing you don&apos;t.</span>
          </h2>
          <p className="text-slate-400 text-lg max-w-2xl mx-auto">
            Zuna is engineered from the ground up with privacy as the foundation —
            not an afterthought.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
          {features.map((feature, i) => {
            const Icon = feature.icon;
            return (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.5, delay: i * 0.08 }}
                whileHover={{ y: -4 }}
                className="group relative bg-bg-card border border-border hover:border-border-light rounded-2xl p-6 transition-all duration-300 cursor-default"
              >
                <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-white/[0.02] to-transparent pointer-events-none" />

                <div className={`w-11 h-11 ${feature.iconBg} rounded-xl flex items-center justify-center mb-5 transition-transform duration-300 group-hover:scale-110`}>
                  <Icon className={`w-5 h-5 ${feature.iconColor}`} />
                </div>

                <div className="flex items-start justify-between gap-3 mb-3">
                  <h3 className="text-white font-semibold text-lg leading-tight">{feature.title}</h3>
                  <span className="text-xs font-mono text-slate-500 bg-bg-elevated border border-border px-2 py-1 rounded-md whitespace-nowrap flex-shrink-0 mt-0.5">
                    {feature.tag}
                  </span>
                </div>

                <p className="text-slate-400 text-sm leading-relaxed">{feature.description}</p>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
