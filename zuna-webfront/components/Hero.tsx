"use client";

import { motion } from "framer-motion";
import {
  Shield,
  Lock,
  Server,
  Download,
  ArrowRight,
  FileText,
  FlaskConical,
} from "lucide-react";

function ChatMockup() {
  return (
    <div className="bg-bg-card border border-border rounded-2xl overflow-hidden shadow-2xl w-full max-w-sm mx-auto lg:max-w-none">
      <div className="bg-bg-elevated px-4 py-3 flex items-center gap-3 border-b border-border">
        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
          A
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-white text-sm font-semibold">Alice</div>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0" />
            <span className="text-slate-400 text-xs">Online</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 bg-accent/10 border border-accent/25 px-2.5 py-1 rounded-full flex-shrink-0">
          <Lock className="w-3 h-3 text-accent-glow" />
          <span className="text-accent-glow text-xs font-medium">E2EE</span>
        </div>
      </div>

      <div
        className="p-4 space-y-3"
        style={{ background: "rgba(6,13,26,0.4)" }}
      >
        <motion.div
          initial={{ opacity: 0, x: -15 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.5, duration: 0.4 }}
          className="flex gap-2 items-end"
        >
          <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
            A
          </div>
          <div className="bg-bg-elevated border border-border/50 rounded-2xl rounded-bl-sm px-3 py-2 max-w-[78%]">
            <p className="text-slate-200 text-sm">
              Hey! Sending the contract 📎
            </p>
            <span className="text-slate-500 text-xs">10:24</span>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, x: -15 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.9, duration: 0.4 }}
          className="flex gap-2 items-end"
        >
          <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
            A
          </div>
          <div className="bg-bg-elevated border border-border/50 rounded-2xl rounded-bl-sm px-3 py-2.5 max-w-[80%]">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 bg-accent/20 rounded-lg flex items-center justify-center flex-shrink-0">
                <FileText className="w-4 h-4 text-accent-glow" />
              </div>
              <div>
                <div className="text-slate-200 text-xs font-medium">
                  Contract_Final.pdf
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <Lock className="w-2.5 h-2.5 text-emerald-400" />
                  <span className="text-emerald-400 text-xs">
                    Encrypted · 2.4 MB
                  </span>
                </div>
              </div>
            </div>
            <span className="text-slate-500 text-xs mt-1.5 block">10:24</span>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, x: 15 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 1.3, duration: 0.4 }}
          className="flex justify-end"
        >
          <div className="bg-accent rounded-2xl rounded-br-sm px-3 py-2 max-w-[78%]">
            <p className="text-white text-sm">Got it! Decrypting now ✓</p>
            <div className="flex items-center justify-end gap-1 mt-0.5">
              <span className="text-blue-200 text-xs">10:25</span>
              <span className="text-blue-200 text-[10px]">✓✓</span>
            </div>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.8 }}
          className="flex gap-2 items-center"
        >
          <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
            A
          </div>
          <div className="bg-bg-elevated border border-border/50 rounded-full px-3 py-2 flex gap-1 items-center">
            {[0, 1, 2].map((i) => (
              <motion.div
                key={i}
                className="w-1.5 h-1.5 rounded-full bg-slate-400"
                animate={{ opacity: [0.3, 1, 0.3], y: [0, -3, 0] }}
                transition={{ repeat: Infinity, duration: 1.2, delay: i * 0.2 }}
              />
            ))}
          </div>
        </motion.div>
      </div>

      <div className="px-4 pb-4 pt-2">
        <div className="bg-bg-elevated border border-border rounded-xl px-4 py-2.5 flex items-center gap-3">
          <span className="text-slate-500 text-sm flex-1">
            Message Alice...
          </span>
          <Lock className="w-3.5 h-3.5 text-accent-light flex-shrink-0" />
        </div>
      </div>
    </div>
  );
}

export default function Hero() {
  const cryptoBadges = [
    "X25519 Key Exchange",
    "AES-256-GCM",
    "Ed25519 Signatures",
  ];

  return (
    <section className="min-h-screen flex items-center relative overflow-hidden pt-16">
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(rgba(37,99,235,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(37,99,235,0.04) 1px, transparent 1px)",
            backgroundSize: "64px 64px",
          }}
        />
        <div className="absolute -top-32 -left-40 w-[700px] h-[700px] rounded-full bg-accent/8 blur-[120px] animate-pulse-glow" />
        <div className="absolute -bottom-40 right-0 w-[500px] h-[500px] rounded-full bg-indigo-600/6 blur-[130px] animate-pulse-glow-delayed" />
        <div
          className="absolute rounded-full blur-[160px]"
          style={{
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: "900px",
            height: "400px",
            background: "rgba(37,99,235,0.03)",
          }}
        />
      </div>

      <div className="container mx-auto px-6 py-28 relative z-10 max-w-7xl">
        <div className="grid lg:grid-cols-2 gap-20 items-center">
          <div>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="inline-flex items-center gap-2 bg-accent/10 border border-accent/25 rounded-full px-4 py-1.5 text-sm text-accent-glow mb-8"
            >
              <Shield className="w-3.5 h-3.5" />
              Open Source · AGPL-3.0 License
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.1 }}
              className="text-5xl lg:text-[4.5rem] font-bold text-white leading-[1.1] mb-6"
            >
              Chat without
              <br />
              <span className="gradient-text">compromise.</span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.2 }}
              className="text-slate-400 text-lg leading-relaxed mb-10 max-w-lg"
            >
              Zuna is a fully self-hosted, end-to-end encrypted messaging
              platform. Your server, your keys, your data — the server never
              sees plaintext. Ever.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.25 }}
              className="flex items-start gap-3 bg-amber-500/8 border border-amber-500/25 rounded-xl px-4 py-3 mb-8 max-w-lg"
            >
              <FlaskConical className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-amber-300/80 text-sm leading-relaxed">
                <span className="font-semibold text-amber-300">
                  Early alpha.
                </span>{" "}
                Zuna is under active development — some features may be
                incomplete or unavailable.
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.3 }}
              className="flex flex-wrap gap-3 mb-10"
            >
              <motion.a
                href="#downloads"
                whileHover={{
                  scale: 1.03,
                  boxShadow: "0 0 32px rgba(37,99,235,0.45)",
                }}
                whileTap={{ scale: 0.97 }}
                className="flex items-center gap-2 bg-accent hover:bg-accent-light text-white font-semibold px-7 py-3.5 rounded-xl transition-colors"
              >
                <Download className="w-5 h-5" />
                Download Now
              </motion.a>
              <motion.a
                href="#self-host"
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                className="flex items-center gap-2 bg-bg-card hover:bg-bg-elevated border border-border text-slate-200 font-semibold px-7 py-3.5 rounded-xl transition-colors"
              >
                <Server className="w-5 h-5" />
                Self-Host
                <ArrowRight className="w-4 h-4 ml-1 opacity-60" />
              </motion.a>
            </motion.div>

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
              className="flex flex-wrap gap-2"
            >
              {cryptoBadges.map((badge) => (
                <span
                  key={badge}
                  className="text-xs font-mono text-slate-500 bg-bg-card border border-border px-3 py-1.5 rounded-lg"
                >
                  {badge}
                </span>
              ))}
            </motion.div>
          </div>

          <motion.div
            initial={{ opacity: 0, x: 40, scale: 0.95 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            transition={{ duration: 0.8, delay: 0.2, ease: "easeOut" }}
            className="relative"
          >
            <div className="absolute -inset-6 bg-accent/6 rounded-3xl blur-2xl pointer-events-none" />
            <div className="relative animate-float">
              <ChatMockup />
            </div>

            <motion.div
              initial={{ opacity: 0, scale: 0.8, x: 20 }}
              animate={{ opacity: 1, scale: 1, x: 0 }}
              transition={{ delay: 1.2, type: "spring", stiffness: 180 }}
              className="absolute -top-5 -right-5 lg:-right-10 bg-bg-card border border-border rounded-2xl p-3.5 shadow-xl hidden sm:block"
            >
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 bg-emerald-500/15 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Shield className="w-4 h-4 text-emerald-400" />
                </div>
                <div>
                  <div className="text-white text-xs font-semibold whitespace-nowrap">
                    Zero-Knowledge
                  </div>
                  <div className="text-slate-400 text-xs whitespace-nowrap">
                    Server sees ciphertext only
                  </div>
                </div>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, scale: 0.8, x: -20 }}
              animate={{ opacity: 1, scale: 1, x: 0 }}
              transition={{ delay: 1.5, type: "spring", stiffness: 180 }}
              className="absolute -bottom-5 -left-5 lg:-left-10 bg-bg-card border border-border rounded-2xl p-3.5 shadow-xl hidden sm:block"
            >
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 bg-accent/15 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Server className="w-4 h-4 text-accent-glow" />
                </div>
                <div>
                  <div className="text-white text-xs font-semibold whitespace-nowrap">
                    Self-Hosted
                  </div>
                  <div className="text-slate-400 text-xs whitespace-nowrap">
                    Docker in 5 minutes
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
