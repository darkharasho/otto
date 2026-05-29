import React from 'react';
import { Text, View } from 'react-native';
import { splitEmoji, hasEmojiIcon } from '@/lib/emoji-icons';
import { FluentEmoji } from './FluentEmoji';

interface Props {
  children: string;
  style?: any;
  /** Icon size — defaults to 13 */
  iconSize?: number;
  /** Icon color — defaults to accent purple */
  iconColor?: string;
}

/**
 * Renders a string replacing emoji with monochrome icons:
 * - Mapped emoji → Lucide SVG icons (instant)
 * - Unmapped emoji → Fluent UI High Contrast SVGs from Iconify CDN
 * - Unknown emoji → stripped
 */
export function EmojiText({ children: text, style, iconSize, iconColor = '#6366f1' }: Props) {
  if (!hasEmojiIcon(text)) {
    return <Text style={style}>{text}</Text>;
  }

  const segments = splitEmoji(text);
  const size = iconSize ?? 13;

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
      {segments.map((seg, i) => {
        if (seg.type === 'text') {
          return <Text key={i} style={style}>{seg.value}</Text>;
        }
        if (seg.type === 'lucide') {
          const { Icon } = seg;
          return <Icon key={i} size={size} color={iconColor} strokeWidth={2.25} />;
        }
        // fluent
        return <FluentEmoji key={i} url={seg.url} size={size} color={iconColor} />;
      })}
    </View>
  );
}
