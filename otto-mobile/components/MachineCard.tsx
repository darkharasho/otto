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
      className="flex-row items-center bg-surface border border-border rounded-xl px-4 py-3 mb-3"
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <View className="w-10 h-10 rounded-lg bg-accent/10 items-center justify-center mr-3">
        <PlatformIcon platform={machine.platform} size={20} color="#6366f1" />
      </View>
      <View className="flex-1 min-w-0">
        <Text className="text-text text-base font-semibold" numberOfLines={1}>
          {machine.label}
        </Text>
        <Text className="text-muted text-xs mt-0.5" numberOfLines={1}>
          {machine.baseUrl.replace(/^https?:\/\//, '')}
          {machine.lastSeen > 0 ? ` · ${relativeTime(machine.lastSeen)}` : ''}
        </Text>
      </View>
      <Pressable
        onPress={handleRename}
        hitSlop={12}
        className="ml-2 p-2"
      >
        <Pencil size={14} color="#71717a" />
      </Pressable>
      <Pressable
        onPress={onDelete}
        hitSlop={12}
        className="p-2"
      >
        <Trash2 size={14} color="#71717a" />
      </Pressable>
    </Pressable>
  );
}
