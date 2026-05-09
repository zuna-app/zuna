import { useState } from 'react';
import { View, Text, Pressable, Image, StyleSheet, Linking, useWindowDimensions } from 'react-native';
import { WebView } from 'react-native-webview';
import YoutubePlayer from 'react-native-youtube-iframe';
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

export type VideoProvider = 'youtube' | 'vimeo' | 'streamable';

export interface VideoEmbed {
  embedUrl: string;
  provider: VideoProvider;
}

export function getVideoEmbed(url: string): VideoEmbed | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');

    // YouTube: youtube.com/watch?v=ID | youtu.be/ID | youtube.com/shorts/ID
    if (host === 'youtube.com' || host === 'youtu.be' || host === 'm.youtube.com') {
      let videoId: string | null = null;
      if (host === 'youtu.be') {
        videoId = u.pathname.slice(1).split('/')[0] || null;
      } else if (u.pathname === '/watch') {
        videoId = u.searchParams.get('v');
      } else {
        const shorts = u.pathname.match(/^\/shorts\/([^/?]+)/);
        if (shorts) videoId = shorts[1];
        const embed = u.pathname.match(/^\/embed\/([^/?]+)/);
        if (embed) videoId = embed[1];
      }
      if (videoId) {
        return {
          embedUrl: `https://www.youtube.com/embed/${videoId}`,
          provider: 'youtube',
        };
      }
    }

    // Vimeo: vimeo.com/ID
    if (host === 'vimeo.com') {
      const match = u.pathname.match(/^\/(\d+)/);
      if (match) {
        return {
          embedUrl: `https://player.vimeo.com/video/${match[1]}`,
          provider: 'vimeo',
        };
      }
    }

    // Streamable: streamable.com/ID
    if (host === 'streamable.com') {
      const match = u.pathname.match(/^\/(?:e\/)?([a-zA-Z0-9]+)$/);
      if (match) {
        return {
          embedUrl: `https://streamable.com/e/${match[1]}`,
          provider: 'streamable',
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

function getYoutubeVideoIdFromEmbed(embedUrl: string): string | null {
  const m = embedUrl.match(/\/embed\/([^/?#]+)/);
  return m?.[1] ?? null;
}

function YoutubeEmbedPlayer({
  embedUrl,
  originalUrl,
  playerWidth,
  playerHeight,
}: {
  embedUrl: string;
  originalUrl: string;
  playerWidth: number;
  playerHeight: number;
}) {
  const [failed, setFailed] = useState(false);
  const videoId = getYoutubeVideoIdFromEmbed(embedUrl);

  if (!videoId || failed) {
    return (
      <Pressable style={styles.youtubeFallback} onPress={() => Linking.openURL(originalUrl)}>
        <Text style={styles.youtubeFallbackTitle}>Unable to play inline</Text>
        <Text style={styles.youtubeFallbackAction}>Open on YouTube</Text>
      </Pressable>
    );
  }

  return (
    <YoutubePlayer
      height={playerHeight}
      width={playerWidth}
      videoId={videoId}
      initialPlayerParams={{
        rel: false,
        modestbranding: true,
        playsinline: true,
      }}
      onError={() => setFailed(true)}
    />
  );
}

export function OgPreview({ url }: Props) {
  const { width } = useWindowDimensions();
  const { data, loading } = useOgPreview(url);
  const videoEmbed = getVideoEmbed(url);

  if (loading && !videoEmbed) {
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

  if (!data && !videoEmbed) return null;

  const domain = getDomain(url);

  if (videoEmbed) {
    const source = { uri: videoEmbed.embedUrl };
    const playerWidth = Math.floor(width * 0.76);
    const playerHeight = Math.floor(playerWidth * 9 / 16);

    const providerLabel = videoEmbed.provider === 'youtube'
      ? 'youtube.com'
      : videoEmbed.provider === 'vimeo'
        ? 'vimeo.com'
        : 'streamable.com';

    return (
      <View style={styles.card}>
        <View style={styles.videoFrame}>
          {videoEmbed.provider === 'youtube' ? (
            <YoutubeEmbedPlayer
              embedUrl={videoEmbed.embedUrl}
              originalUrl={url}
              playerWidth={playerWidth}
              playerHeight={playerHeight}
            />
          ) : (
            <WebView
              source={source}
              style={styles.webview}
              javaScriptEnabled
              domStorageEnabled
              allowsInlineMediaPlayback
              allowsFullscreenVideo
              mediaPlaybackRequiresUserAction={false}
              scrollEnabled={false}
              thirdPartyCookiesEnabled
              allowsBackForwardNavigationGestures={false}
            />
          )}
        </View>
        <Pressable style={styles.body} onPress={() => Linking.openURL(url)}>
          <View style={styles.siteRow}>
            <GlobeIcon size={10} color="#71717a" />
            <Text style={styles.site} numberOfLines={1}>
              {data?.siteName ?? providerLabel}
            </Text>
          </View>
          <Text style={styles.title} numberOfLines={1}>
            {data?.title ?? 'Video preview'}
          </Text>
          {data?.description && (
            <Text style={styles.description} numberOfLines={2}>
              {data.description}
            </Text>
          )}
        </Pressable>
      </View>
    );
  }

  return (
    <Pressable style={styles.card} onPress={() => Linking.openURL(url)}>
      {data?.image && (
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
            {data?.siteName ?? domain}
          </Text>
        </View>
        {data?.title && (
          <Text style={styles.title} numberOfLines={1}>
            {data.title}
          </Text>
        )}
        {data?.description && (
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
  videoFrame: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: '#000',
  },
  webview: {
    flex: 1,
    backgroundColor: '#000',
  },
  youtubeFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#000',
  },
  youtubeFallbackTitle: {
    color: '#d4d4d8',
    fontSize: 12,
    fontWeight: '600',
  },
  youtubeFallbackAction: {
    color: '#60a5fa',
    fontSize: 12,
    fontWeight: '600',
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
