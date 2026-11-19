import React from 'react';
import { Image, Text, View } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { toLocalImageSrc } from '@shared/image-src';
import { splitEmoji, hasEmojiIcon } from '@/lib/emoji-icons';
import { authHeaders } from '@/lib/wire';
import { colors } from '@/lib/theme';
import { FluentEmoji } from './FluentEmoji';

const styles = {
  body: { color: colors.text, fontSize: 14 },
  paragraph: { marginTop: 2, marginBottom: 2 },
  heading1: { color: colors.text, fontSize: 16, fontWeight: '600' as const, marginTop: 8, marginBottom: 4 },
  heading2: { color: colors.text, fontSize: 15, fontWeight: '600' as const, marginTop: 8, marginBottom: 4 },
  heading3: { color: colors.text, fontSize: 14, fontWeight: '600' as const, marginTop: 8, marginBottom: 4 },
  code_inline: { backgroundColor: colors.surface, color: colors.text, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4, fontSize: 13 },
  code_block: { backgroundColor: colors.surface, color: colors.text, padding: 8, borderRadius: 8, fontSize: 12 },
  fence: { backgroundColor: colors.surface, color: colors.text, padding: 8, borderRadius: 8, fontSize: 12 },
  link: { color: colors.accent },
  blockquote: { backgroundColor: 'transparent', borderLeftColor: colors.border, borderLeftWidth: 2, paddingLeft: 8, marginVertical: 4 },
  bullet_list: { marginVertical: 2 },
  ordered_list: { marginVertical: 2 },
  list_item: { marginVertical: 1 },
  hr: { backgroundColor: colors.border, height: 1 },
  table: { borderColor: colors.border },
  th: { borderColor: colors.border, padding: 4 },
  td: { borderColor: colors.border, padding: 4 },
};

interface Props {
  children: string;
  /** Desktop to load markdown images through (its /image cache). */
  baseUrl: string;
  token: string;
}

/** Markdown for chat bubbles: emoji become monochrome icons, and images load
 *  through the desktop so the phone never fetches third-party hosts itself. */
export function ChatMarkdown({ children, baseUrl, token }: Props) {
  const rules = React.useMemo(() => ({
    image: (node: any) => {
      const uri = toLocalImageSrc(node.attributes?.src, { kind: 'remote', basePath: baseUrl });
      if (!uri) return null;
      return (
        <Image
          key={node.key}
          source={{ uri, headers: authHeaders(token) }}
          accessibilityLabel={node.attributes?.alt}
          style={{ width: '100%', height: 200, borderRadius: 8, marginVertical: 4 }}
          resizeMode="contain"
        />
      );
    },
    // SVG icons can't nest inside <Text>, so a text group containing a mapped
    // emoji is rebuilt as a wrapping row of <Text> and icons.
    textgroup: (node: any, children: any, _parent: any, st: any) => {
      const hasEmoji = node.children?.some(
        (c: any) => c.type === 'text' && typeof c.content === 'string' && hasEmojiIcon(c.content),
      );
      if (!hasEmoji) {
        return <Text key={node.key} style={st.textgroup}>{children}</Text>;
      }
      const elements: React.ReactNode[] = [];
      let k = 0;
      node.children.forEach((child: any, idx: number) => {
        if (child.type === 'text' && typeof child.content === 'string' && hasEmojiIcon(child.content)) {
          for (const seg of splitEmoji(child.content)) {
            if (seg.type === 'text') {
              elements.push(<Text key={k++} style={[st.text, { color: colors.text, fontSize: 14 }]}>{seg.value}</Text>);
            } else if (seg.type === 'lucide') {
              const { Icon } = seg;
              elements.push(<Icon key={k++} size={14} color={colors.accent} strokeWidth={2.25} />);
            } else {
              elements.push(<FluentEmoji key={k++} url={seg.url} size={14} color={colors.accent} />);
            }
          }
        } else {
          elements.push(children[idx]);
        }
      });
      return (
        <View key={node.key} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
          {elements}
        </View>
      );
    },
  }), [baseUrl, token]);

  return <Markdown style={styles} rules={rules}>{children}</Markdown>;
}
