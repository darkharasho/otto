import { View, Text, Pressable, Alert } from 'react-native';
import { Trash2, Pencil } from 'lucide-react-native';
import type { Machine } from '@/lib/store';
import { useTheme } from '@/lib/theme';
import { PlatformIcon } from './PlatformIcon';

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

interface Props {
  machine: Machine;
  onPress(): void;
  onDelete(): void;
  onRename(newLabel: string): void;
}

export function MachineCard({ machine, onPress, onDelete, onRename }: Props) {
  const t = useTheme();

  const handleRename = () => {
    Alert.prompt(
      'Rename machine',
      'Enter a new name for this machine.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Save',
          onPress: (value?: string) => {
            const trimmed = (value ?? '').trim();
            if (trimmed && trimmed !== machine.label) onRename(trimmed);
          },
        },
      ],
      'plain-text',
      machine.label,
    );
  };

  return (
    <Pressable
      onPress={onPress}
      onLongPress={handleRename}
      style={({ pressed }) => ({
        backgroundColor: t.surface,
        borderWidth: 1,
        borderColor: t.border,
        borderRadius: 14,
        paddingHorizontal: 16,
        paddingVertical: 14,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ width: 40, height: 40, borderRadius: 8, backgroundColor: t.accentBg, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
          <PlatformIcon platform={machine.platform} size={20} color={t.accent} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>
            {machine.label}
          </Text>
          <Text style={{ color: t.textMuted, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
            {machine.baseUrl.replace(/^https?:\/\//, '').replace(/\.tail[^.]*\.ts\.net/, '').replace(/:\d+$/, '')}
            {machine.lastSeen > 0 ? ` · ${relativeTime(machine.lastSeen)}` : ''}
          </Text>
        </View>
        <Pressable
          onPress={handleRename}
          hitSlop={12}
          style={{ marginLeft: 8, padding: 8 }}
        >
          <Pencil size={14} color={t.textMuted} />
        </Pressable>
        <Pressable
          onPress={onDelete}
          hitSlop={12}
          style={{ padding: 8 }}
        >
          <Trash2 size={14} color={t.textMuted} />
        </Pressable>
      </View>
    </Pressable>
  );
}
