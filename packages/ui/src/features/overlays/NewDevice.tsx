// Asking about a device that signed in to the person's account after this one, over everything,
// until they say whether it was them: no click outside, Escape or close button sends it away. One
// that wasn't is removed, and they're asked next to change the secret it signed in with.

import { ShieldAlert } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { quick, useAction } from "@/components/ui";
import { useEscape } from "@/lib/escape";
import { formatFull } from "@/lib/format";
import { useApp } from "@/state/store";

const nothing = () => {};

export function NewDevicePrompt() {
  // Each a value the store holds, as a selector that makes a new one each time never settles.
  const askedOn = useApp((state) => state.order.find((id) => (state.servers[id]?.newDevices.length ?? 0) > 0) ?? null);
  const asked = useApp((state) => (askedOn ? (state.servers[askedOn]?.newDevices[0] ?? null) : null));
  const removed = useApp((state) => state.deviceRemoved);
  if (!removed && !asked) return null;
  return <Prompt key={removed ? "removed" : asked!.id} />;
}

function Prompt() {
  const state = useApp();
  const { busy, run } = useAction();
  const card = useRef<HTMLDivElement>(null);
  // The newest layer, so Escape reaches nothing under it, and does nothing here.
  useEscape(nothing);
  // Focus leaves whatever was typed into under it, and lands on neither answer.
  useEffect(() => card.current?.focus(), []);

  let title: string;
  let text: string;
  let buttons: React.ReactNode;
  const removed = state.deviceRemoved;
  if (removed) {
    const recovery = removed.secret === "recovery";
    title = "The device was removed";
    text = recovery
      ? "Whoever signed in on it has your recovery key, so they can sign in again until you make a new one. Make one now."
      : removed.secret === "password"
        ? "Whoever signed in on it knows your password, so they can sign in again until you change it. Change it now."
        : "Whoever signed in on it may know your password or your recovery key. Change your password and make a new recovery key now.";
    buttons = (
      <>
        <button className="btn btn-ghost" onClick={() => state.setDeviceRemoved(null)}>
          Later
        </button>
        <button
          className="btn btn-primary"
          onClick={() => {
            state.setDeviceRemoved(null);
            state.selectServer(removed.serverId);
            state.setOverlay({ type: "settings", section: "security" });
          }}
        >
          {recovery ? "Make a new recovery key" : "Change password"}
        </button>
      </>
    );
  } else {
    const serverId = state.order.find((id) => (state.servers[id]?.newDevices.length ?? 0) > 0)!;
    const server = state.servers[serverId]!;
    const device = server.newDevices[0]!;
    const secret = device.secret === "recovery" ? "your recovery key" : "your password";
    title = "Was this you?";
    text = `“${device.name}” signed in to your account on ${server.info?.name || server.entry.name} on ${formatFull(device.createdAt)}. If it wasn't you, someone else has ${secret} and is signed in as you.`;
    const answer = (mine: boolean) =>
      run(async () => {
        await state.session(serverId).answerNewDevice(device.id, mine);
        useApp.setState((now) => {
          const current = now.servers[serverId];
          if (!current) return now;
          return { servers: { ...now.servers, [serverId]: { ...current, newDevices: current.newDevices.filter((item) => item.id !== device.id) } } };
        });
        if (!mine) state.setDeviceRemoved({ serverId, secret: device.secret });
      });
    buttons = (
      <>
        <button className="btn btn-danger" disabled={busy} onClick={() => answer(false)}>
          No, remove it
        </button>
        <button className="btn btn-primary" disabled={busy} onClick={() => answer(true)}>
          Yes, it was me
        </button>
      </>
    );
  }

  return createPortal(
    <motion.div className="modal-layer new-device-layer" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.08 }}>
      <motion.div
        ref={card}
        className="modal new-device"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="new-device-title"
        aria-describedby="new-device-text"
        tabIndex={-1}
        style={{ maxWidth: 440 }}
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={quick}
      >
        <div className="modal-head">
          <ShieldAlert size={18} className="new-device-icon" />
          <h2 id="new-device-title">{title}</h2>
        </div>
        <div className="modal-body" id="new-device-text">
          {text}
        </div>
        <div className="modal-foot">{buttons}</div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}
