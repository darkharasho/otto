import { View, Text, Pressable } from 'react-native';
import * as Haptics from 'expo-haptics';

const CLASS_COLORS: Record<string, string> = {
  read: 'bg-emerald-600',
  reversible: 'bg-blue-600',
  destructive: 'bg-orange-600',
  irreversible: 'bg-red-600',
};

interface Props {
  decisionId: string;
  tool: string;
  actionClass: string;
  summary: string;
  onResolve(decision: 'approve' | 'deny'): void;
}

export function ApprovalCard({ tool, actionClass, summary, onResolve }: Props) {
  const colorClass = CLASS_COLORS[actionClass] ?? 'bg-zinc-600';

  const handleResolve = (decision: 'approve' | 'deny') => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onResolve(decision);
  };

  return (
    <View className="rounded-xl border border-border bg-surface p-3">
      <View className="flex-row items-center gap-2 mb-2">
        <Text className="font-semibold text-sm text-text">{tool}</Text>
        <View className={`rounded px-2 py-0.5 ${colorClass}`}>
          <Text className="text-xs text-white">{actionClass}</Text>
        </View>
      </View>
      {summary ? (
        <Text className="text-sm text-muted mb-3" numberOfLines={3}>{summary}</Text>
      ) : null}
      <View className="flex-row gap-2">
        <Pressable
          onPress={() => handleResolve('deny')}
          className="flex-1 rounded-lg border border-border bg-bg py-2.5 items-center"
        >
          <Text className="text-text text-sm font-medium">Deny</Text>
        </Pressable>
        <Pressable
          onPress={() => handleResolve('approve')}
          className="flex-1 rounded-lg bg-accent py-2.5 items-center"
        >
          <Text className="text-white text-sm font-medium">Approve</Text>
        </Pressable>
      </View>
    </View>
  );
}
