import { useState, useRef } from 'react';
import {
  View, TextInput, Pressable, StyleSheet, ActionSheetIOS, Text, Image,
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
import { useEmotes } from '@/hooks/chat/useEmotes';

type EmoteSuggestion = {
  query: string;
  start: number;
  results: Array<[string, string]>;
};

function detectSuggestion(text: string, cursor: number): { query: string; start: number } | null {
  const before = text.slice(0, cursor);
  const match = before.match(/:([a-zA-Z0-9_]+)$/);
  if (!match) return null;
  return { query: match[1], start: before.length - match[0].length };
}

interface Props {
  sharedSecret: string | null;
  replyingTo: Message | null;
  editingMessage: Message | null;
  sevenTvEnabled?: boolean;
  sevenTvEmotesSet?: string | null;
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
  sevenTvEnabled = true,
  sevenTvEmotesSet = null,
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
  const [suggestion, setSuggestion] = useState<EmoteSuggestion | null>(null);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const writingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isWritingRef = useRef(false);
  const inputRef = useRef<TextInput>(null);
  const { emoteMap } = useEmotes(sevenTvEmotesSet, sevenTvEnabled);

  function updateSuggestion(nextText: string, cursor: number) {
    if (emoteMap.size === 0) {
      setSuggestion(null);
      return;
    }

    const detected = detectSuggestion(nextText, cursor);
    if (!detected) {
      setSuggestion(null);
      return;
    }

    const query = detected.query.toLowerCase();
    const results = Array.from(emoteMap.entries()).filter(([name]) =>
      name.toLowerCase().startsWith(query),
    );

    if (results.length === 0) {
      setSuggestion(null);
      return;
    }

    setSuggestion({
      query: detected.query,
      start: detected.start,
      results: results.slice(0, 24),
    });
  }

  function commitSuggestion(name: string, start: number) {
    const before = text.slice(0, start);
    const after = text.slice(selection.start);
    const suffix = after.length > 0 && !after.startsWith(' ') ? ' ' : ' ';
    const nextText = before + name + suffix + after;
    const nextCursor = before.length + name.length + suffix.length;

    setText(nextText);
    setSuggestion(null);
    setSelection({ start: nextCursor, end: nextCursor });

    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }

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
    updateSuggestion(value, selection.start > value.length ? value.length : selection.start);
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
      setSuggestion(null);
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
    setSuggestion(null);
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
      {suggestion && (
        <View style={styles.suggestionList}>
          {suggestion.results.map(([name, url]) => (
            <Pressable
              key={name}
              style={styles.suggestionItem}
              onPress={() => commitSuggestion(name, suggestion.start)}>
              <Image source={{ uri: url }} style={styles.suggestionImage} />
              <Text style={styles.suggestionText}>:{name}</Text>
            </Pressable>
          ))}
        </View>
      )}

      <View style={styles.row}>
        <Pressable style={styles.attachBtn} onPress={showAttachmentPicker}>
          <PaperclipIcon size={20} color="#71717a" />
        </Pressable>

        <TextInput
          ref={inputRef}
          style={styles.input}
          value={text}
          onChangeText={handleTextChange}
          onSelectionChange={(event) => {
            const nextSelection = event.nativeEvent.selection;
            setSelection(nextSelection);
            updateSuggestion(text, nextSelection.start);
          }}
          selection={selection}
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
  suggestionList: {
    marginHorizontal: 14,
    marginTop: 8,
    marginBottom: 2,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#27272a',
    backgroundColor: '#09090b',
    overflow: 'hidden',
  },
  suggestionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#18181b',
  },
  suggestionImage: {
    width: 28,
    height: 28,
  },
  suggestionText: {
    color: '#f4f4f5',
    fontSize: 14,
    fontWeight: '500',
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
