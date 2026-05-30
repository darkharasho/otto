import { View, Text, Pressable } from 'react-native';
import * as Haptics from 'expo-haptics';

const CLASS_COLORS: Record<string, string> = {
  read: '#059669',
  reversible: '#2563eb',
  destructive: '#ea580c',
  irreversible: '#dc2626',
};

interface Props {
  decisionId: string;
  tool: string;
  actionClass: string;
  summary: string;
  onResolve(decision: 'approve' | 'deny'): void;
}

export function ApprovalCard({ tool, actionClass, summary, onResolve }: Props) {
  const colorClass = CLASS_COLORS[actionClass] ?? '#52525b';

  const handleResolve = (decision: 'approve' | 'deny') => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onResolve(decision);
  };

  return (
    <View style={{ borderRadius: 12, borderWidth: 1, borderColor: '#2a2a2e', backgroundColor: '#1a1a1c', padding: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Text style={{ fontWeight: '600', fontSize: 14, color: '#e4e4e7' }}>{tool}</Text>
        <View style={{ borderRadius: 4, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: colorClass }}>
          <Text style={{ fontSize: 12, color: '#ffffff' }}>{actionClass}</Text>
        </View>
      </View>
      {summary ? (
        <Text style={{ fontSize: 14, color: '#71717a', marginBottom: 12 }} numberOfLines={3}>{summary}</Text>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable
          onPress={() => handleResolve('deny')}
          style={{ flex: 1, borderRadius: 8, borderWidth: 1, borderColor: '#2a2a2e', backgroundColor: '#0d0d0e', paddingVertical: 10, alignItems: 'center' }}
        >
          <Text style={{ color: '#e4e4e7', fontSize: 14, fontWeight: '500' }}>Deny</Text>
        </Pressable>
        <Pressable
          onPress={() => handleResolve('approve')}
          style={{ flex: 1, borderRadius: 8, backgroundColor: '#6366f1', paddingVertical: 10, alignItems: 'center' }}
        >
          <Text style={{ color: '#ffffff', fontSize: 14, fontWeight: '500' }}>Approve</Text>
        </Pressable>
      </View>
    </View>
  );
}
