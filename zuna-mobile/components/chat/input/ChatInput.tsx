import { useState, useRef, useCallback } from 'react';
import {
  View, TextInput, Pressable, StyleSheet, ActionSheetIOS,
  Platform, Alert,
} from 'react-native';
import { SendIcon, PaperclipIcon } from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { ReplyPreview } from './ReplyPreview';
import { EditingBanner } from './EditingBanner';
import { AttachmentPreview, PendingFile } from './AttachmentPreview';
import { Message } from '@/types/serverTypes';
import { encrypt } from '@/lib/crypto/x25519';

interface Props {
  sharedSecret: string | null;
  replyingTo: Message | null;
  editingMessage: Message | null;
  getPlaintext: (msg: Message) => string | undefined;
  onSend: (cipherText: string, iv: string, authTag: string, plaintext: string) => void;
  onSendReply: (cipherText: string, iv: string, authTag: string, plaintext: string, replyToId: number) => void;
  onEdit: (messageId: number, cipherText: string, iv: string, authTag: string, plaintext: string) => void;
  onUpload: (fileUri: string, fileName: string, fileSize: number, mimeType: string, caption: string) => void;
  onCancelReply: () => void;
  onCancelEdit: () => void;
  onWriting: (writing: boolean) => void;
}

export function ChatInput({
  sharedSecret,
  replyingTo,
  editingMessage,
  getPlaintext,
  onSend,
  onSendReply,
  onEdit,
  onUpload,
  onCancelReply,
  onCancelEdit,
  onWriting,
}: Props) {
  const [text, setText] = useState('');
  const [pendingFile, setPendingFile] = useState<PendingFile | null>(null);
  const writingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isWritingRef = useRef(false);

  // Pre-fill when entering edit mode
  const prevEditingId = useRef<number | null>(null);
  if (editingMessage && editingMessage.id !== prevEditingId.current) {
    prevEditingId.current = editingMessage.id;
    const existing = getPlaintext(editingMessage) ?? editingMessage.plaintext ?? '';
    if (text !== existing) setText(existing);
  }
  if (!editingMessage && prevEditingId.current !== null) {
    prevEditingId.current = null;
    if (text && !replyingTo) setText('');
  }

  function handleTextChange(value: string) {
    setText(value);
    if (!isWritingRef.current) {
      isWritingRef.current = true;
      onWriting(true);
    }
    if (writingTimerRef.current) clearTimeout(writingTimerRef.current);
    writingTimerRef.current = setTimeout(() => {
      isWritingRef.current = false;
      onWriting(false);
    }, 2000);
  }

  async function handleSend() {
    if (!sharedSecret) return;
    const trimmed = text.trim();

    if (pendingFile) {
      onUpload(pendingFile.uri, pendingFile.name, pendingFile.size, pendingFile.mimeType, trimmed);
      setPendingFile(null);
      setText('');
      return;
    }

    if (!trimmed) return;

    const encrypted = encrypt(sharedSecret, trimmed);

    if (editingMessage?.id != null) {
      onEdit(editingMessage.id, encrypted.ciphertext, encrypted.iv, encrypted.authTag, trimmed);
      onCancelEdit();
    } else if (replyingTo?.id != null) {
      onSendReply(encrypted.ciphertext, encrypted.iv, encrypted.authTag, trimmed, replyingTo.id);
      onCancelReply();
    } else {
      onSend(encrypted.ciphertext, encrypted.iv, encrypted.authTag, trimmed);
    }

    setText('');
    if (writingTimerRef.current) clearTimeout(writingTimerRef.current);
    isWritingRef.current = false;
    onWriting(false);
  }

  function showAttachmentPicker() {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Camera', 'Photo Library', 'File', 'Cancel'], cancelButtonIndex: 3 },
        (i) => {
          if (i === 0) pickCamera();
          else if (i === 1) pickImage();
          else if (i === 2) pickFile();
        },
      );
    } else {
      Alert.alert('Attach', undefined, [
        { text: 'Camera', onPress: pickCamera },
        { text: 'Photo Library', onPress: pickImage },
        { text: 'File', onPress: pickFile },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }

  async function pickCamera() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') return;
    const result = await ImagePicker.launchCameraAsync({ quality: 0.85 });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      setPendingFile({
        uri: asset.uri,
        name: `photo_${Date.now()}.jpg`,
        size: asset.fileSize ?? 0,
        mimeType: asset.mimeType ?? 'image/jpeg',
      });
    }
  }

  async function pickImage() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') return;
    const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.85, allowsMultipleSelection: false });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      setPendingFile({
        uri: asset.uri,
        name: asset.fileName ?? `image_${Date.now()}.jpg`,
        size: asset.fileSize ?? 0,
        mimeType: asset.mimeType ?? 'image/jpeg',
      });
    }
  }

  async function pickFile() {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      setPendingFile({
        uri: asset.uri,
        name: asset.name,
        size: asset.size ?? 0,
        mimeType: asset.mimeType ?? 'application/octet-stream',
      });
    }
  }

  const canSend = !!sharedSecret && (text.trim().length > 0 || pendingFile != null);

  return (
    <View style={styles.wrapper}>
      {replyingTo && !editingMessage && (
        <ReplyPreview message={replyingTo} getPlaintext={getPlaintext} onDismiss={onCancelReply} />
      )}
      {editingMessage && <EditingBanner onDismiss={onCancelEdit} />}
      {pendingFile && <AttachmentPreview file={pendingFile} onRemove={() => setPendingFile(null)} />}

      <View style={styles.row}>
        <Pressable style={styles.attachBtn} onPress={showAttachmentPicker}>
          <PaperclipIcon size={20} color="#71717a" />
        </Pressable>

        <TextInput
          style={styles.input}
          value={text}
          onChangeText={handleTextChange}
          placeholder="Message…"
          placeholderTextColor="#52525b"
          multiline
          maxLength={4000}
          returnKeyType="default"
        />

        <Pressable
          style={[styles.sendBtn, canSend && styles.sendBtnActive]}
          onPress={handleSend}
          disabled={!canSend}
        >
          <SendIcon size={18} color={canSend ? '#000' : '#52525b'} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    backgroundColor: '#0a0a0a',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#18181b',
    paddingBottom: 16,
  },
  row: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 14, paddingVertical: 8, gap: 6,
  },
  attachBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  input: {
    flex: 1,
    backgroundColor: '#18181b', borderRadius: 20,
    paddingVertical: 8, paddingHorizontal: 14,
    color: '#fff', fontSize: 15, maxHeight: 120,
  },
  sendBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#27272a', alignItems: 'center', justifyContent: 'center',
  },
  sendBtnActive: { backgroundColor: '#fff' },
});
