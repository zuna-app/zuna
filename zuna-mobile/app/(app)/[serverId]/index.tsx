import { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { FlashList } from '@shopify/flash-list';
import { Drawer } from 'react-native-drawer-layout';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  jotaiStore,
  serverListAtom,
  selectedChatAtom,
  lastMessagesAtom,
  vaultAtom,
  serverMetaAtom,
} from '@/store/atoms';
import { serverTokensAtom } from '@/store/atoms';
import { useChatList } from '@/hooks/chat/useChatList';
import { useSharedSecret, computeSharedSecretFromVault } from '@/hooks/ws/useSharedSecret';
import { useBackgroundMessages } from '@/hooks/ws/useBackgroundMessages';
import { decrypt } from '@/lib/crypto/x25519';
import { ChatListItem } from '@/components/chat/ChatListItem';
import { ServerDrawer } from '@/components/chat/ServerDrawer';
import { Server, ChatMember } from '@/types/serverTypes';
import { MenuIcon } from 'lucide-react-native';

const ATTACHMENT_PREVIEW = '📎 Attachment';
const ZERO_WIDTH_SPACE = '\u200b';

export default function ChatListScreen() {
  const { serverId } = useLocalSearchParams<{ serverId: string }>();
  const router = useRouter();
  const serverList = useAtomValue(serverListAtom, { store: jotaiStore });
  const server = serverList.find((s) => s.id === serverId);
  const tokens = useAtomValue(serverTokensAtom, { store: jotaiStore });
  const token = server ? tokens.get(server.id) : null;
  const serverMeta = useAtomValue(serverMetaAtom, { store: jotaiStore });
  const serverDisplayName =
    (server && serverMeta.get(server.id)?.name) || server?.name || server?.address || '';

  const selectedChat = useAtomValue(selectedChatAtom, { store: jotaiStore });
  const setSelectedChat = useSetAtom(selectedChatAtom, { store: jotaiStore });
  const lastMessages = useAtomValue(lastMessagesAtom, { store: jotaiStore });
  const vault = useAtomValue(vaultAtom, { store: jotaiStore });

  const [search, setSearch] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);

  const { data: members = [], isPending, refetch } = useChatList(server!);

  // Seed lastMessages with decrypted previews from chat list
  const setLastMessages = useSetAtom(lastMessagesAtom, { store: jotaiStore });
  useEffect(() => {
    if (!vault || !members.length) return;
    for (const member of members) {
      if (lastMessages[member.chatId]) continue;
      const secret = computeSharedSecretFromVault(vault, member.identityKey);
      if (!secret || !member.ciphertext || !member.iv || !member.authTag) continue;
      try {
        const plaintext = decrypt(secret, {
          ciphertext: member.ciphertext,
          iv: member.iv,
          authTag: member.authTag,
        });
        const content = plaintext === ZERO_WIDTH_SPACE ? ATTACHMENT_PREVIEW : plaintext;
        setLastMessages((prev) => {
          if (prev[member.chatId]) return prev;
          return {
            ...prev,
            [member.chatId]: {
              chatId: member.chatId,
              senderId: member.senderId,
              content,
              unreadMessages: member.unreadMessages ?? 0,
              lastActivityAt: member.lastActivityAt ?? 0,
            },
          };
        });
      } catch {}
    }
  }, [members, vault]);

  useBackgroundMessages(server!, members);

  const filtered = search.trim()
    ? members.filter((m) => m.username.toLowerCase().includes(search.toLowerCase()))
    : members;

  const sorted = [...filtered].sort((a, b) => {
    const aTs = lastMessages[a.chatId]?.lastActivityAt ?? a.lastActivityAt ?? 0;
    const bTs = lastMessages[b.chatId]?.lastActivityAt ?? b.lastActivityAt ?? 0;
    return bTs - aTs;
  });

  useFocusEffect(
    useCallback(() => {
      setSelectedChat(null);
    }, [setSelectedChat])
  );

  function openChat(member: ChatMember) {
    setSelectedChat(member);
    router.push(`/(app)/${serverId}/chat/${member.chatId}` as any);
  }

  if (!server || !token) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color="#fff" />
        <Text style={styles.loadingText}>Authenticating…</Text>
        <Text style={styles.loadingText}>{server ? server.address : 'Connecting to server…'}</Text>
      </View>
    );
  }

  return (
    <Drawer
      drawerStyle={{ width: 300 }}
      drawerPosition="left"
      renderDrawerContent={() => <ServerDrawer onClose={() => setDrawerOpen(false)} />}
      open={drawerOpen}
      onOpen={() => setDrawerOpen(true)}
      onClose={() => setDrawerOpen(false)}>
      <SafeAreaView style={styles.container} edges={['top']}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable style={styles.menuBtn} onPress={() => setDrawerOpen(true)}>
            <MenuIcon size={22} color="#fff" />
          </Pressable>
          <Text style={styles.serverName} numberOfLines={1}>
            {serverDisplayName}
          </Text>
        </View>

        {/* Search */}
        <View style={styles.searchWrapper}>
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            placeholder="Search conversations…"
            placeholderTextColor="#52525b"
          />
        </View>

        {isPending ? (
          <View style={styles.centerContent}>
            <ActivityIndicator color="#fff" />
          </View>
        ) : sorted.length === 0 ? (
          <View style={styles.centerContent}>
            <Text style={styles.emptyText}>No conversations yet</Text>
          </View>
        ) : (
          <FlashList
            data={sorted}
            estimatedItemSize={68}
            keyExtractor={(m) => m.chatId}
            renderItem={({ item }) => (
              <ChatListItem
                member={item}
                lastMessage={lastMessages[item.chatId]}
                isSelected={selectedChat?.chatId === item.chatId}
                onPress={() => openChat(item)}
              />
            )}
          />
        )}
      </SafeAreaView>
    </Drawer>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0a0a0a',
    gap: 12,
  },
  loadingText: { color: '#71717a', fontSize: 14 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  menuBtn: { padding: 4 },
  serverName: { color: '#fff', fontWeight: '700', fontSize: 18, flex: 1 },
  searchWrapper: { paddingHorizontal: 16, paddingBottom: 8 },
  searchInput: {
    backgroundColor: '#18181b',
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 14,
    color: '#fff',
    fontSize: 14,
  },
  centerContent: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: '#52525b', fontSize: 14 },
});
