import { useCallback, useEffect, useRef } from "react";
import { useAtom, useSetAtom } from "jotai";
import {
  AudioPresets,
  ExternalE2EEKeyProvider,
  Room,
  RoomEvent,
  Track,
  RemoteAudioTrack,
  type LocalAudioTrack,
  createLocalAudioTrack,
} from "livekit-client";
import {
  activeVoiceChannelAtom,
  voiceChannelParticipantsAtom,
  voiceMutedAtom,
  voiceSpeakingAtom,
  jotaiStore,
} from "../../store/atoms";
import { useWsConnection } from "../ws/useWsConnection";
import { useWsHandler } from "../ws/useWsHandler";
import { WS_MSG } from "../ws/wsTypes";
import { base64ToBytes } from "../../crypto/base64";
import { usePlatform } from "../../platform/PlatformContext";
import type { Server, VoiceParticipant } from "../../types/serverTypes";
import type {
  VoiceChannelTokenPayload,
  VoiceChannelUpdatePayload,
} from "../ws/wsTypes";

function rawPayloadToParticipants(
  raw: Array<{ user_id: string; username: string; avatar: string }>,
): VoiceParticipant[] {
  return raw.map((p) => ({
    userId: p.user_id,
    username: p.username,
    avatar: p.avatar,
  }));
}

export function useVoiceChannel(server: Server) {
  const { sendMessage } = useWsConnection(server);
  const { vault } = usePlatform();

  const roomRef = useRef<Room | null>(null);
  const audioTrackRef = useRef<LocalAudioTrack | null>(null);

  const [activeChannelId, setActiveChannelId] = useAtom(
    activeVoiceChannelAtom,
    { store: jotaiStore },
  );
  const [muted, setMuted] = useAtom(voiceMutedAtom, { store: jotaiStore });
  const setParticipants = useSetAtom(voiceChannelParticipantsAtom, {
    store: jotaiStore,
  });
  const setSpeaking = useSetAtom(voiceSpeakingAtom, { store: jotaiStore });

  const activeChannelIdRef = useRef(activeChannelId?.id ?? null);
  activeChannelIdRef.current = activeChannelId?.id ?? null;

  const pendingChannelNameRef = useRef<string>("");

  const disconnectRoom = useCallback(async () => {
    if (audioTrackRef.current) {
      try {
        await roomRef.current?.localParticipant.unpublishTrack(
          audioTrackRef.current,
        );
        audioTrackRef.current.stop();
      } catch {}
      audioTrackRef.current = null;
    }
    if (roomRef.current) {
      try {
        await roomRef.current.disconnect();
      } catch {}
      roomRef.current = null;
    }
  }, []);

  useWsHandler<VoiceChannelTokenPayload>(
    server,
    WS_MSG.VOICE_CHANNEL_TOKEN,
    async (payload) => {
      const { channel_id, livekit_url, livekit_token, participants } = payload;

      const channelKeyB64 = (await vault.get(`channel_key_${channel_id}`)) as
        | string
        | null;
      if (!channelKeyB64) {
        console.error("[voice] no channel key found for", channel_id);
        return;
      }

      await disconnectRoom();

      const rawKey = base64ToBytes(channelKeyB64);
      const keyProvider = new ExternalE2EEKeyProvider();
      await keyProvider.setKey(rawKey.buffer as ArrayBuffer);

      const e2eeWorker = new Worker(
        new URL("livekit-client/e2ee-worker", import.meta.url),
      );

      const room = new Room({
        adaptiveStream: false,
        dynacast: false,
        e2ee: { keyProvider, worker: e2eeWorker },
      });

      room.on(RoomEvent.Disconnected, () => {
        audioTrackRef.current = null;
        roomRef.current = null;
        setActiveChannelId(null);
        setMuted(false);
        setSpeaking(new Set<string>());
      });

      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        setSpeaking(new Set<string>(speakers.map((p) => p.identity)));
      });

      // Ensure remote audio tracks are attached and playing
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== Track.Kind.Audio) return;
        const audioTrack = track as RemoteAudioTrack;
        if (audioTrack.attachedElements.length === 0) {
          const el = audioTrack.attach();
          el.autoplay = true;
          document.body.appendChild(el);
          el.play().catch(() => {});
        } else {
          audioTrack.attachedElements.forEach((el) => {
            if (el.paused) el.play().catch(() => {});
          });
        }
      });

      try {
        await room.connect(livekit_url, livekit_token);
        await room.startAudio();

        // Re-check all already-subscribed remote tracks after startAudio
        for (const participant of room.remoteParticipants.values()) {
          for (const pub of participant.trackPublications.values()) {
            if (pub.kind !== Track.Kind.Audio || !pub.track) continue;
            const audioTrack = pub.track as RemoteAudioTrack;
            if (audioTrack.attachedElements.length === 0) {
              const el = audioTrack.attach();
              el.autoplay = true;
              document.body.appendChild(el);
              el.play().catch(() => {});
            } else {
              audioTrack.attachedElements.forEach((el) => {
                if (el.paused) el.play().catch(() => {});
              });
            }
          }
        }

        const audioTrack = await createLocalAudioTrack({
          echoCancellation: true,
          noiseSuppression: true,
        });
        await room.localParticipant.publishTrack(audioTrack, {
          audioPreset: AudioPresets.speech,
          dtx: true,
        });

        roomRef.current = room;
        audioTrackRef.current = audioTrack;
        setActiveChannelId({
          id: channel_id,
          name: pendingChannelNameRef.current,
        });
        setMuted(false);
        setParticipants((prev) => {
          const next = new Map(prev);
          next.set(channel_id, rawPayloadToParticipants(participants));
          return next;
        });
      } catch (err) {
        console.error("[voice] failed to connect to LiveKit room:", err);
        await disconnectRoom();
      }
    },
  );

  useWsHandler<VoiceChannelUpdatePayload>(
    server,
    WS_MSG.VOICE_CHANNEL_UPDATE,
    (payload) => {
      const { channel_id, participants } = payload;
      setParticipants((prev) => {
        const next = new Map(prev);
        next.set(channel_id, rawPayloadToParticipants(participants));
        return next;
      });
    },
  );

  // Disconnect on unmount (server switch / logout)
  useEffect(() => {
    return () => {
      if (activeChannelIdRef.current) {
        disconnectRoom();
      }
    };
  }, [disconnectRoom]);

  const joinVoiceChannel = useCallback(
    (channelId: string, channelName: string) => {
      if (
        activeChannelIdRef.current &&
        activeChannelIdRef.current !== channelId
      ) {
        sendMessage(WS_MSG.VOICE_CHANNEL_LEAVE, {
          channel_id: activeChannelIdRef.current,
        });
        disconnectRoom();
        setActiveChannelId(null);
      }
      pendingChannelNameRef.current = channelName;
      sendMessage(WS_MSG.VOICE_CHANNEL_JOIN, { channel_id: channelId });
    },
    [sendMessage, disconnectRoom, setActiveChannelId],
  );

  const leaveVoiceChannel = useCallback(async () => {
    const channelId = activeChannelIdRef.current;
    await disconnectRoom();
    setActiveChannelId(null);
    setMuted(false);
    if (channelId) {
      sendMessage(WS_MSG.VOICE_CHANNEL_LEAVE, { channel_id: channelId });
    }
  }, [disconnectRoom, setActiveChannelId, setMuted, sendMessage]);

  const toggleMute = useCallback(async () => {
    if (!audioTrackRef.current) return;
    if (muted) {
      await audioTrackRef.current.unmute();
      setMuted(false);
    } else {
      await audioTrackRef.current.mute();
      setMuted(true);
    }
  }, [muted, setMuted]);

  return { joinVoiceChannel, leaveVoiceChannel, toggleMute };
}
