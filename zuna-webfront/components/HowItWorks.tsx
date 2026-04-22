"use client";

import { motion } from "framer-motion";
import { Server, KeyRound, MessageSquare } from "lucide-react";

const steps = [
  {
    number: "01",
    icon: Server,
    iconBg: "bg-blue-500/15",
    iconColor: "text-blue-400",
    title: "Deploy Your Server",
    description:
      "Clone the repo and run a single Docker Compose command. Zuna bundles the chat server, MariaDB, and optional LiveKit media server. Configure a TOML file and you're live.",
    code: "docker compose up -d",
  },
  {
    number: "02",
    icon: KeyRound,
    iconBg: "bg-indigo-500/15",
    iconColor: "text-indigo-400",
    title: "Generate Your Keys",
    description:
      "Open the desktop app and complete first-time setup. Your Ed25519 signing key and X25519 encryption key are generated entirely offline — they never leave your device.",
    code: "Keys generated locally",
  },
  {
    number: "03",
    icon: MessageSquare,
    iconBg: "bg-violet-500/15",
    iconColor: "text-violet-400",
    title: "Start Chatting",
    description:
      "Connect to your server, invite friends, and start messaging. Every message is encrypted on your device before sending. The server never decrypts a single byte.",
    code: "Zero-knowledge server",
  },
];

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="py-32 relative overflow-hidden">
      <div
        className="absolute rounded-full blur-[140px] pointer-events-none"
        style={{
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "600px",
          height: "600px",
          background: "rgba(37,99,235,0.04)",
        }}
      />

      <div className="container mx-auto px-6 max-w-7xl relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-20"
        >
          <div className="inline-flex items-center gap-2 bg-accent/10 border border-accent/25 rounded-full px-4 py-1.5 text-sm text-accent-glow mb-6">
            <MessageSquare className="w-3.5 h-3.5" />
            Quick Start
          </div>
          <h2 className="text-4xl lg:text-5xl font-bold text-white mb-5">
            Up and running <span className="gradient-text">in minutes.</span>
          </h2>
          <p className="text-slate-400 text-lg max-w-xl mx-auto">
            No third-party accounts. No telemetry. No waiting. Just clone,
            deploy, and chat.
          </p>
        </motion.div>

        <div className="relative">
          <div className="grid lg:grid-cols-3 gap-8 lg:gap-12">
            {steps.map((step, i) => {
              const Icon = step.icon;
              return (
                <motion.div
                  key={step.number}
                  initial={{ opacity: 0, y: 40 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: "-60px" }}
                  transition={{ duration: 0.6, delay: i * 0.15 }}
                  className="relative"
                >
                  <div className="relative flex justify-center lg:justify-start mb-8">
                    <div className="w-14 h-14 rounded-2xl bg-bg-card border-2 border-border flex items-center justify-center relative z-10">
                      <span className="text-slate-500 font-mono text-sm font-bold">
                        {step.number}
                      </span>
                    </div>
                  </div>

                  <div className="bg-bg-card border border-border rounded-2xl p-6 hover:border-border-light transition-all duration-300 hover:-translate-y-1">
                    <div
                      className={`w-10 h-10 ${step.iconBg} rounded-xl flex items-center justify-center mb-5`}
                    >
                      <Icon className={`w-5 h-5 ${step.iconColor}`} />
                    </div>

                    <h3 className="text-white font-semibold text-xl mb-3">
                      {step.title}
                    </h3>
                    <p className="text-slate-400 text-sm leading-relaxed mb-5">
                      {step.description}
                    </p>

                    <div className="bg-bg-base rounded-lg px-3 py-2 border border-border/60 flex items-center gap-2">
                      <span className="text-accent-glow text-xs font-mono">
                        $
                      </span>
                      <span className="text-slate-300 text-xs font-mono">
                        {step.code}
                      </span>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
