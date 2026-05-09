import { View, Text, Pressable, Image, StyleSheet, Linking } from 'react-native';
import { GlobeIcon } from 'lucide-react-native';
import { useOgPreview } from '@/hooks/ui/useOgPreview';

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

interface Props {
  url: string;
}

export function OgPreview({ url }: Props) {
  const { data, loading } = useOgPreview(url);

  if (loading) {
    return (
      <View style={styles.skeleton}>
        <View style={styles.skeletonImg} />
        <View style={styles.skeletonBody}>
          <View style={[styles.skeletonLine, { width: '50%' }]} />
          <View style={[styles.skeletonLine, { width: '85%' }]} />
          <View style={[styles.skeletonLine, { width: '65%' }]} />
        </View>
      </View>
    );
  }

  if (!data) return null;

  const domain = getDomain(url);

  return (
    <Pressable style={styles.card} onPress={() => Linking.openURL(url)}>
      {data.image && (
        <Image
          source={{ uri: data.image }}
          style={styles.image}
          resizeMode="cover"
          onError={(e) => {
            // hide broken images by setting height to 0 isn't directly possible,
            // but the Image component will just show nothing on error
          }}
        />
      )}
      <View style={styles.body}>
        <View style={styles.siteRow}>
          <GlobeIcon size={10} color="#71717a" />
          <Text style={styles.site} numberOfLines={1}>
            {data.siteName ?? domain}
          </Text>
        </View>
        {data.title && (
          <Text style={styles.title} numberOfLines={1}>
            {data.title}
          </Text>
        )}
        {data.description && (
          <Text style={styles.description} numberOfLines={2}>
            {data.description}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  skeleton: {
    flexDirection: 'row',
    backgroundColor: '#18181b',
    borderRadius: 12,
    overflow: 'hidden',
    marginTop: 4,
  },
  skeletonImg: {
    width: 64,
    height: 64,
    backgroundColor: '#27272a',
  },
  skeletonBody: {
    flex: 1,
    padding: 10,
    gap: 6,
    justifyContent: 'center',
  },
  skeletonLine: {
    height: 8,
    backgroundColor: '#27272a',
    borderRadius: 4,
  },
  card: {
    backgroundColor: '#18181b',
    borderRadius: 12,
    overflow: 'hidden',
    marginTop: 4,
  },
  image: {
    width: '100%',
    height: 120,
  },
  body: {
    padding: 10,
    gap: 3,
  },
  siteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  site: {
    color: '#71717a',
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    flexShrink: 1,
  },
  title: {
    color: '#f4f4f5',
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  description: {
    color: '#a1a1aa',
    fontSize: 11,
    lineHeight: 15,
  },
});
