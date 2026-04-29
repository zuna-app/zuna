import { Modal, View, Pressable, StyleSheet, StatusBar } from 'react-native';
import { Image } from 'expo-image';
import { XIcon } from 'lucide-react-native';

interface Props {
  uri: string | null;
  onClose: () => void;
}

export function ImageLightbox({ uri, onClose }: Props) {
  if (!uri) return null;

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent>
      <StatusBar hidden />
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <Image source={{ uri }} style={styles.image} contentFit="contain" />
        <Pressable style={styles.closeBtn} onPress={onClose}>
          <XIcon size={22} color="#fff" />
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  image: { width: '100%', height: '100%' },
  closeBtn: {
    position: 'absolute', top: 50, right: 20,
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 20,
    width: 40, height: 40, alignItems: 'center', justifyContent: 'center',
  },
});
