import { Modal, View, Text, Pressable, FlatList, StyleSheet } from 'react-native';
import { XIcon, PinIcon } from 'lucide-react-native';
import { Message } from '@/types/serverTypes';
import { SafeAreaView } from 'react-native-safe-area-context';

interface Props {
  visible: boolean;
  messages: Message[];
  getPlaintext: (msg: Message) => string | undefined;
  onClose: () => void;
  onScrollTo: (id: number) => void;
  onUnpin: (id: number) => void;
}

export function PinnedMessagesSheet({ visible, messages, getPlaintext, onClose, onScrollTo, onUnpin }: Props) {
  const pinned = messages.filter((m) => m.pinned);

  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent>
      <View style={styles.overlay}>
        <SafeAreaView style={styles.sheet} edges={['bottom']}>
          <View style={styles.header}>
            <PinIcon size={18} color="#fff" />
            <Text style={styles.title}>Pinned Messages ({pinned.length})</Text>
            <Pressable onPress={onClose}>
              <XIcon size={20} color="#71717a" />
            </Pressable>
          </View>

          {pinned.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No pinned messages</Text>
            </View>
          ) : (
            <FlatList
              data={pinned}
              keyExtractor={(m) => String(m.id)}
              renderItem={({ item }) => (
                <Pressable style={styles.item} onPress={() => { item.id && onScrollTo(item.id); onClose(); }}>
                  <Text style={styles.itemText} numberOfLines={2}>
                    {item.attachmentId ? '📎 Attachment' : (getPlaintext(item) ?? '…')}
                  </Text>
                  <Pressable onPress={() => item.id && onUnpin(item.id)}>
                    <XIcon size={15} color="#52525b" />
                  </Pressable>
                </Pressable>
              )}
            />
          )}
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    backgroundColor: '#09090b', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    maxHeight: '60%', paddingTop: 4, marginBottom: 18,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 20, paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#18181b',
  },
  title: { color: '#fff', fontWeight: '600', fontSize: 16, flex: 1 },
  empty: { padding: 32, alignItems: 'center' },
  emptyText: { color: '#52525b' },
  item: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20,
    paddingVertical: 12, gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#18181b',
  },
  itemText: { color: '#d4d4d8', fontSize: 14, flex: 1 },
});
