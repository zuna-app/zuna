import { View, Text, Pressable, StyleSheet } from 'react-native';
import { ReplyInfo } from '@/types/serverTypes';
import { decrypt } from '@/lib/crypto/x25519';
import { useEffect, useState } from 'react';

interface Props {
  replyInfo: ReplyInfo;
  sharedSecret: string | null;
  onPress?: () => void;
}

export function ReplyBubble({ replyInfo, sharedSecret, onPress }: Props) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!sharedSecret || !replyInfo.cipher_text) return;
    try {
      const plaintext = decrypt(sharedSecret, {
        ciphertext: replyInfo.cipher_text,
        iv: replyInfo.iv,
        authTag: replyInfo.auth_tag,
      });
      setText(plaintext);
    } catch {
      setText('[message]');
    }
  }, [sharedSecret, replyInfo.cipher_text]);

  return (
    <Pressable style={styles.container} onPress={onPress}>
      <View style={styles.bar} />
      <Text style={styles.text} numberOfLines={2}>
        {replyInfo.has_attachment ? '📎 Attachment' : (text ?? '…')}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#18181b',
    borderRadius: 8,
    marginBottom: 4,
    maxWidth: 240,
    overflow: 'hidden',
  },
  bar: { width: 3, alignSelf: 'stretch', backgroundColor: '#71717a', marginRight: 8 },
  text: { color: '#71717a', fontSize: 12, flex: 1, paddingVertical: 6, paddingRight: 8 },
});
