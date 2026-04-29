import { View, Text, Pressable, StyleSheet } from 'react-native';
import { XIcon, PencilIcon } from 'lucide-react-native';

interface Props {
  onDismiss: () => void;
}

export function EditingBanner({ onDismiss }: Props) {
  return (
    <View style={styles.container}>
      <PencilIcon size={14} color="#60a5fa" />
      <Text style={styles.text}>Editing message</Text>
      <Pressable onPress={onDismiss} hitSlop={8}>
        <XIcon size={16} color="#71717a" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#18181b',
    paddingVertical: 8, paddingHorizontal: 14,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#27272a',
  },
  text: { flex: 1, color: '#60a5fa', fontSize: 13 },
});
