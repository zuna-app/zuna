import { View, Text, Image, StyleSheet } from 'react-native';

interface AvatarProps {
  name: string;
  size?: number;
  uri?: string | null;
}

function getInitials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

function colorFromName(name: string): string {
  const colors = ['#7c3aed', '#2563eb', '#059669', '#d97706', '#dc2626', '#db2777'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

export function Avatar({ name, size = 40, uri }: AvatarProps) {
  const bg = colorFromName(name);
  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}
        resizeMode="cover"
      />
    );
  }
  return (
    <View
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: bg },
      ]}>
      <Text style={[styles.initials, { fontSize: size * 0.35 }]}>{getInitials(name)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: { alignItems: 'center', justifyContent: 'center' },
  initials: { color: '#fff', fontWeight: '700' },
});
