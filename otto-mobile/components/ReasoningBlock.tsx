import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Brain, ChevronDown } from 'lucide-react-native';
import { colors } from '@/lib/theme';

/** Otto's summarized reasoning: collapsed once the reply starts. */
export function ReasoningBlock({ text, done }: { text: string; done: boolean }) {
  const [open, setOpen] = useState(false);
  const expanded = open || !done;
  return (
    <Pressable onPress={() => setOpen((v) => !v)} style={{ borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: 10, paddingVertical: 2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Brain size={12} color={colors.textMuted} />
        <Text style={{ color: colors.textMuted, fontSize: 12 }}>{done ? 'Thought' : 'Thinking'}</Text>
        <ChevronDown size={12} color={colors.textMuted} style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }} />
      </View>
      {expanded ? <Text style={{ color: colors.textDim, fontSize: 13, marginTop: 4, fontStyle: 'italic' }}>{text}</Text> : null}
    </Pressable>
  );
}
