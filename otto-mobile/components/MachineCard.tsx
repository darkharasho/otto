import { View, Text, Pressable, Alert } from 'react-native';
import { Trash2, Pencil } from 'lucide-react-native';
import type { Machine } from '@/lib/store';
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
        backgroundColor: '#1a1a1c',
        borderWidth: 1,
        borderColor: '#2a2a2e',
        borderRadius: 12,
        paddingHorizontal: 16,
        paddingVertical: 12,
        marginBottom: 12,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ width: 40, height: 40, borderRadius: 8, backgroundColor: 'rgba(99,102,241,0.1)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
          <PlatformIcon platform={machine.platform} size={20} color="#6366f1" />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: '#e4e4e7', fontSize: 14, fontWeight: '600' }} numberOfLines={1}>
            {machine.label}
          </Text>
          <Text style={{ color: '#71717a', fontSize: 12, marginTop: 2 }} numberOfLines={1}>
            {machine.baseUrl.replace(/^https?:\/\//, '').replace(/\.tail[^.]*\.ts\.net/, '').replace(/:\d+$/, '')}
            {machine.lastSeen > 0 ? ` · ${relativeTime(machine.lastSeen)}` : ''}
          </Text>
        </View>
        <Pressable
          onPress={handleRename}
          hitSlop={12}
          style={{ marginLeft: 8, padding: 8 }}
        >
          <Pencil size={14} color="#71717a" />
        </Pressable>
        <Pressable
          onPress={onDelete}
          hitSlop={12}
          style={{ padding: 8 }}
        >
          <Trash2 size={14} color="#71717a" />
        </Pressable>
      </View>
    </Pressable>
  );
}
