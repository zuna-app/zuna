// The soundboard, end to end through a real server: admins add sounds whose names and
// files the server can't read, every sound comes out about as loud and as short as the
// rest, and one someone plays reaches only the others in their voice channel or call,
// as played by whom it really was, and once.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, decode } from "../src/api";
import { frameSigned, sealEnvelope, sealSignal } from "../src/crypto";
import { fromUtf8, toBase64 } from "../src/encoding";
import { openSoundDetails } from "../src/soundboard";
import { prepareSound, readWav, SOUND_RATE, writeWav } from "../src/sounds";
import type { CoreEvent } from "../src/types";
import { loadCrypto, TestApp, TestServer, waitFor } from "./helpers";

/** A tone as WAV, after some silence, as an app would hand over what someone picked. */
function tone(seconds: number, amplitude: number, silence = 0): Uint8Array<ArrayBuffer> {
  const quiet = Math.round(silence * SOUND_RATE);
  const samples = new Int16Array(quiet + Math.round(seconds * SOUND_RATE));
  for (let index = quiet; index < samples.length; index++) samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / SOUND_RATE) * amplitude * 32767);
  return writeWav(samples);
}

function loudness(wav: Uint8Array): { rms: number; peak: number } {
  const samples = readWav(wav)!;
  let squares = 0;
  let peak = 0;
  for (const sample of samples) {
    squares += (sample / 32768) ** 2;
    peak = Math.max(peak, Math.abs(sample / 32768));
  }
  return { rms: Math.sqrt(squares / samples.length), peak };
}

const decibels = (ratio: number) => 20 * Math.log10(ratio);

describe("preparing a sound", () => {
  it("cuts the silence off either end and holds it to five seconds", () => {
    const short = prepareSound(tone(1, 0.5, 2));
    // What's kept of the silence before it is 10 ms.
    expect(short.durationMs).toBe(1010);
    // It fades in, so it doesn't click.
    expect(readWav(short.wav)![0]).toBe(0);

    const long = prepareSound(tone(8, 0.5, 1));
    expect(long.durationMs).toBe(5000);
  });

  it("makes quiet sounds and loud ones about as loud as each other", () => {
    const quiet = loudness(prepareSound(tone(1, 0.01)).wav);
    const loud = loudness(prepareSound(tone(1, 0.99)).wav);
    expect(Math.abs(decibels(quiet.rms / loud.rms))).toBeLessThan(0.5);
    expect(decibels(loud.rms)).toBeCloseTo(-18, 0);
    // And none goes past just under full scale, however it's made louder.
    const spike = new Int16Array(SOUND_RATE);
    spike[SOUND_RATE / 2] = 32767;
    spike[SOUND_RATE / 2 + 1] = 100;
    expect(loudness(prepareSound(writeWav(spike)).wav).peak).toBeLessThanOrEqual(10 ** (-1 / 20) + 1e-4);
  });

  it("refuses silence, and anything but WAV in one channel at 48 kHz", () => {
    expect(() => prepareSound(writeWav(new Int16Array(SOUND_RATE)))).toThrow(/silent/);
    const stereo = tone(1, 0.5);
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect(() => prepareSound(stereo)).toThrow(/couldn't be read/);
    const slower = tone(1, 0.5);
    new DataView(slower.buffer).setUint32(24, 44_100, true);
    expect(() => prepareSound(slower)).toThrow(/couldn't be read/);
    expect(() => prepareSound(new TextEncoder().encode("not a sound at all, not even close to one"))).toThrow(/couldn't be read/);
  });
});

describe("the soundboard", () => {
  let server: TestServer;
  let alice: TestApp;
  let bob: TestApp;
  let carol: TestApp;
  let channelId = "";
  let soundId = "";
  const voice = { muted: false, deafened: false, camera: false, screen: false };
  const sounds = (app: TestApp) => app.events.filter((event): event is Extract<CoreEvent, { type: "sound" }> => event.type === "sound");
  const joined = (app: TestApp) => !!app.session.getChannels().find((item) => item.id === channelId)?.conversation?.ready;

  beforeAll(async () => {
    loadCrypto();
    server = new TestServer({ liveKit: "wss://voice.invalid" });
    await server.start();
    alice = await new TestApp("alice").open();
    await alice.register(server.setupLink, "alice");
    const invite = await alice.session.createInvite(0, 0);
    bob = await new TestApp("bob").open();
    await bob.register(invite, "bob");
    carol = await new TestApp("carol").open();
    await carol.register(invite, "carol");
    channelId = await alice.session.createChannel({ type: "voice", name: "Lounge" });
    await waitFor(() => joined(bob) && joined(carol), "bob and carol to come into the channel");
  });

  afterAll(async () => {
    for (const app of [alice, bob, carol]) app?.client.stop();
    await server?.stop();
  });

  it("is filled by admins, with what each sound is called and sounds like kept from the server", async () => {
    soundId = await alice.session.addSound(new Blob([tone(1, 0.3, 0.5)]), "Airhorn", "📯");
    await waitFor(() => bob.session.getSounds().some((sound) => sound.id === soundId), "bob to see the sound");
    expect(bob.session.getSounds()).toEqual([{ id: soundId, name: "Airhorn", emoji: "📯", durationMs: 1010 }]);

    const file = await bob.session.soundFile(soundId);
    expect(Math.round((readWav(new Uint8Array(await file.arrayBuffer()))!.length * 1000) / SOUND_RATE)).toBe(1010);

    const api = new Api(server.url);
    api.token = (bob.session as unknown as { account: { token: string } }).account.token;
    const [listed] = await api.sounds();
    expect(fromUtf8(decode(listed!.details)).includes("Airhorn")).toBe(false);
    // Another sound's details can't be passed off as this one's.
    const communityKey = (bob.session as unknown as { account: { core: { communityKey: Uint8Array } } }).account.core.communityKey;
    expect(openSoundDetails(communityKey, soundId, decode(listed!.details))).not.toBeNull();
    expect(openSoundDetails(communityKey, "0".repeat(32), decode(listed!.details))).toBeNull();

    await expect(bob.session.addSound(new Blob([tone(1, 0.3)]), "Mine")).rejects.toThrow();
    await expect(alice.session.addSound(new Blob([tone(1, 0.3)]), "")).rejects.toThrow(/name/);
  });

  it("is renamed by admins for everyone", async () => {
    await alice.session.updateSound(soundId, { name: "Horn", emoji: "🎺" });
    await waitFor(() => bob.session.getSounds()[0]?.name === "Horn", "bob to see the new name");
    expect(bob.session.getSounds()[0]).toMatchObject({ emoji: "🎺", durationMs: 1010 });
  });

  it("plays a sound to the others in the voice channel, and nobody else", async () => {
    alice.session.setVoiceState(channelId, voice);
    bob.session.setVoiceState(channelId, voice);
    await waitFor(() => alice.session.getVoiceMembers().filter((member) => member.channelId === channelId).length === 2, "both to be in the channel");
    await expect(carol.session.playSound(channelId, soundId)).rejects.toThrow(/Join/);

    await alice.session.playSound(channelId, soundId);
    await waitFor(() => sounds(bob).length === 1, "bob to hear the sound");
    expect(sounds(bob)[0]).toMatchObject({ channelId, userId: alice.userId, soundId });
    expect(sounds(alice)).toHaveLength(0);
    expect(sounds(carol)).toHaveLength(0);
  });

  it("plays nothing that's handed on again, or passed off as someone else's", async () => {
    const session = bob.session as unknown as {
      rememberCurrentEpochKey(groupId: string): number;
      epochKey(groupId: string, epoch: number): Uint8Array;
      onSoundFrame(data: { channel_id: string; user_id: string; data: string }): void;
    };
    const epoch = session.rememberCurrentEpochKey(channelId);
    const key = session.epochKey(channelId, epoch);
    const before = sounds(bob).length;
    // As a device signs one, in whichever room and with whatever it says.
    const signal = (by: TestApp, user: string, at = Date.now(), room = channelId) => {
      const { deviceId, deviceSecret } = (by.session as any).account;
      const play = { sound: soundId, user, at, nonce: `${user}-${at}` };
      return toBase64(frameSigned(deviceId, epoch, sealEnvelope(key, deviceSecret, "play", room, by.userId, epoch, play, { userId: by.userId, deviceId })));
    };

    const fromAlice = signal(alice, alice.userId);
    session.onSoundFrame({ channel_id: channelId, user_id: alice.userId, data: fromAlice });
    session.onSoundFrame({ channel_id: channelId, user_id: alice.userId, data: fromAlice });
    expect(sounds(bob).length).toBe(before + 1);
    // Carol's, as the server says alice played it.
    session.onSoundFrame({ channel_id: channelId, user_id: alice.userId, data: signal(carol, carol.userId) });
    // One saying it's alice's, but signed by carol's device.
    session.onSoundFrame({ channel_id: channelId, user_id: alice.userId, data: signal(carol, alice.userId) });
    // Not signed at all, as anyone in the room could make one.
    session.onSoundFrame({ channel_id: channelId, user_id: alice.userId, data: toBase64(sealSignal(key, "play", channelId, epoch, { sound: soundId, user: alice.userId, at: Date.now(), nonce: "unsigned" })) });
    // From long ago.
    session.onSoundFrame({ channel_id: channelId, user_id: alice.userId, data: signal(alice, alice.userId, Date.now() - 60 * 60_000) });
    // For another room.
    session.onSoundFrame({ channel_id: "f".repeat(32), user_id: alice.userId, data: signal(alice, alice.userId) });
    expect(sounds(bob).length).toBe(before + 1);
  });

  it("can't be played while muted", async () => {
    bob.session.setVoiceState(channelId, { ...voice, muted: true });
    await waitFor(() => alice.session.getVoiceMembers().some((member) => member.userId === bob.userId && member.muted), "bob to be muted");
    await expect(bob.session.playSound(channelId, soundId)).rejects.toThrow(/Unmute/);
    bob.session.setVoiceState(channelId, voice);
  });

  it("can be turned off in a channel", async () => {
    expect(bob.session.getChannels().find((item) => item.id === channelId)?.sounds).toBe(true);
    await alice.session.updateChannel(channelId, { sounds: false });
    await waitFor(() => bob.session.getChannels().find((item) => item.id === channelId)?.sounds === false, "bob to see it's off");
    await expect(alice.session.playSound(channelId, soundId)).rejects.toThrow(/off/);
    await alice.session.updateChannel(channelId, { sounds: true });
  });

  it("is taken away by admins for everyone", async () => {
    await alice.session.deleteSound(soundId);
    await waitFor(() => bob.session.getSounds().length === 0, "bob to see it gone");
    await expect(alice.session.playSound(channelId, soundId)).rejects.toThrow(/anymore/);
  });
});
