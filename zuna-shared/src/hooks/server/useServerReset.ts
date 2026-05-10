import { useEffect } from "react";
import { useSetAtom } from "jotai";
import {
  channelMembersAtom,
  channelMessagesAtom,
  channelWritingAtom,
  lastMessagesAtom,
  presenceAtom,
  writingAtom,
  voiceChannelParticipantsAtom,
  voiceSpeakingAtom,
  voiceMutedParticipantsAtom,
  voiceParticipantVolumesAtom,
  jotaiStore,
} from "../../store/atoms";

export function useServerReset(serverId: string) {
  const setChannelMembers = useSetAtom(channelMembersAtom, { store: jotaiStore });
  const setChannelMessages = useSetAtom(channelMessagesAtom, { store: jotaiStore });
  const setChannelWriting = useSetAtom(channelWritingAtom, { store: jotaiStore });
  const setLastMessages = useSetAtom(lastMessagesAtom, { store: jotaiStore });
  const setPresence = useSetAtom(presenceAtom, { store: jotaiStore });
  const setWriting = useSetAtom(writingAtom, { store: jotaiStore });
  const setVoiceParticipants = useSetAtom(voiceChannelParticipantsAtom, { store: jotaiStore });
  const setSpeaking = useSetAtom(voiceSpeakingAtom, { store: jotaiStore });
  const setMutedParticipants = useSetAtom(voiceMutedParticipantsAtom, { store: jotaiStore });
  const setParticipantVolumes = useSetAtom(voiceParticipantVolumesAtom, { store: jotaiStore });

  useEffect(() => {
    setChannelMembers(new Map());
    setChannelMessages(new Map());
    setChannelWriting(new Map());
    setLastMessages({});
    setPresence(new Map());
    setWriting(new Map());
    setVoiceParticipants(new Map());
    setSpeaking(new Set<string>());
    setMutedParticipants(new Set<string>());
    setParticipantVolumes(new Map());
  }, [serverId]); // eslint-disable-line react-hooks/exhaustive-deps
}
