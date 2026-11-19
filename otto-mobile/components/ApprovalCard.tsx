import { View, Text, Pressable } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { PendingApproval } from '@/lib/transcript';
import { colors } from '@/lib/theme';

const CLASS_COLORS: Record<string, string> = {
  read: '#059669',
  reversible: '#2563eb',
  destructive: '#ea580c',
  irreversible: '#dc2626',
};

interface Props {
  approval: PendingApproval;
  onResolve(decision: 'approve' | 'deny'): void;
}

export function ApprovalCard({ approval, onResolve }: Props) {
  const { tool, actionClass, summary, reason, catastrophic } = approval;

  const resolve = (decision: 'approve' | 'deny') => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onResolve(decision);
  };

  return (
    <View style={{ borderRadius: 12, borderWidth: 1, borderColor: catastrophic ? colors.dangerBorder : colors.border, backgroundColor: colors.surface, padding: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Text style={{ fontWeight: '600', fontSize: 14, color: colors.text }}>{tool}</Text>
        <View style={{ borderRadius: 4, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: CLASS_COLORS[actionClass] ?? '#52525b' }}>
          <Text style={{ fontSize: 12, color: colors.white }}>{actionClass}</Text>
        </View>
      </View>
      {summary ? <Text style={{ fontSize: 14, color: colors.text, marginBottom: 6 }} numberOfLines={4}>{summary}</Text> : null}
      {reason ? <Text style={{ fontSize: 13, color: colors.textMuted, marginBottom: 12 }} numberOfLines={4}>{reason}</Text> : null}
      {catastrophic ? (
        <Text style={{ fontSize: 13, color: colors.danger, marginBottom: 12 }}>
          This command is on Otto's blocklist. It can only be approved on your computer.
        </Text>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable
          onPress={() => resolve('deny')}
          style={{ flex: 1, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, paddingVertical: 10, alignItems: 'center' }}
        >
          <Text style={{ color: colors.text, fontSize: 14, fontWeight: '500' }}>Deny</Text>
        </Pressable>
        {!catastrophic && (
          <Pressable
            onPress={() => resolve('approve')}
            style={{ flex: 1, borderRadius: 8, backgroundColor: colors.accent, paddingVertical: 10, alignItems: 'center' }}
          >
            <Text style={{ color: colors.white, fontSize: 14, fontWeight: '500' }}>Approve</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
