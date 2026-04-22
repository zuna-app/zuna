"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Server, Copy, Check, Terminal, ChevronRight } from "lucide-react";

const dockerCompose = `services:
  zuna-server:
    build:
      context: ./zuna-server
    ports:
      - "8080:8080"
    environment:
      MYSQL_HOST: zuna-mysql
      MYSQL_USER: \${MYSQL_USER:-zuna}
      MYSQL_PASSWORD: \${MYSQL_PASSWORD:-zunapass}
      LIVEKIT_HOST: livekit
    volumes:
      - zuna-data:/data
    depends_on:
      - zuna-mysql
      - livekit

  zuna-mysql:
    image: mariadb:11
    environment:
      MYSQL_DATABASE: \${MYSQL_DATABASE:-zuna}
      MYSQL_USER: \${MYSQL_USER:-zuna}
      MYSQL_PASSWORD: \${MYSQL_PASSWORD:-zunapass}
    volumes:
      - zuna-mysql-data:/var/lib/mysql

  livekit:
    image: livekit/livekit-server:latest
    ports:
      - "7880:7880"
      - "50000-60000:50000-60000/udp"

volumes:
  zuna-data:
  zuna-mysql-data:`;

const steps = [
  {
    cmd: "git clone https://github.com/zuna-app/zuna",
    label: "Clone the repository",
  },
  { cmd: "cd zuna", label: "Enter the directory" },
  { cmd: "docker compose up -d", label: "Start all services" },
];

function CodeBlock() {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(dockerCompose);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-bg-base border border-border rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-elevated/50">
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/60" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
            <div className="w-3 h-3 rounded-full bg-green-500/60" />
          </div>
          <span className="text-slate-500 text-xs font-mono ml-2">
            docker-compose.yml
          </span>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 text-slate-400 hover:text-white text-xs transition-colors px-2 py-1 rounded-lg hover:bg-bg-elevated cursor-pointer"
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-emerald-400" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre className="p-5 text-xs font-mono text-slate-300 overflow-x-auto leading-relaxed">
        <code>{dockerCompose}</code>
      </pre>
    </div>
  );
}

export default function SelfHost() {
  return (
    <section id="self-host" className="py-32 relative overflow-hidden">
      <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-border to-transparent pointer-events-none" />
      <div
        className="absolute -bottom-20 -right-20 rounded-full blur-[130px] pointer-events-none"
        style={{
          width: "500px",
          height: "500px",
          background: "rgba(37,99,235,0.05)",
        }}
      />

      <div className="container mx-auto px-6 max-w-7xl relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <div className="inline-flex items-center gap-2 bg-accent/10 border border-accent/25 rounded-full px-4 py-1.5 text-sm text-accent-glow mb-6">
            <Server className="w-3.5 h-3.5" />
            Self-Hosting Guide
          </div>
          <h2 className="text-4xl lg:text-5xl font-bold text-white mb-5">
            Own your <span className="gradient-text">infrastructure.</span>
          </h2>
          <p className="text-slate-400 text-lg max-w-xl mx-auto">
            One Docker Compose command spins up the chat server, database, and
            LiveKit media server. No DevOps expertise required.
          </p>
        </motion.div>

        <div className="grid lg:grid-cols-2 gap-12 items-start">
          <motion.div
            initial={{ opacity: 0, x: -30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.6 }}
          >
            <div className="space-y-4 mb-8">
              {steps.map((step, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: -20 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.5, delay: i * 0.1 }}
                  className="flex items-center gap-4 bg-bg-card border border-border rounded-xl px-5 py-4 hover:border-border-light transition-colors"
                >
                  <div className="w-7 h-7 rounded-lg bg-accent/15 border border-accent/25 flex items-center justify-center flex-shrink-0">
                    <span className="text-accent-glow text-xs font-bold">
                      {i + 1}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-slate-400 text-xs mb-1">
                      {step.label}
                    </div>
                    <div className="flex items-center gap-2">
                      <Terminal className="w-3.5 h-3.5 text-slate-600 flex-shrink-0" />
                      <code className="text-slate-200 text-sm font-mono truncate">
                        {step.cmd}
                      </code>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-600 flex-shrink-0" />
                </motion.div>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-4">
              {[
                {
                  label: "SQLite & MariaDB",
                  desc: "Flexible database options",
                },
                { label: "TLS Built-in", desc: "Auto-generated certificates" },
                { label: "TOML Config", desc: "Simple configuration file" },
                { label: "Rate Limiting", desc: "DDoS & abuse protection" },
              ].map((item) => (
                <div
                  key={item.label}
                  className="bg-bg-card border border-border rounded-xl p-4"
                >
                  <div className="text-white text-sm font-semibold mb-1">
                    {item.label}
                  </div>
                  <div className="text-slate-500 text-xs">{item.desc}</div>
                </div>
              ))}
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, x: 30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <CodeBlock />
          </motion.div>
        </div>
      </div>
    </section>
  );
}
