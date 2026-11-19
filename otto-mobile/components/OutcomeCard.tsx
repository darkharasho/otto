import { View, Text } from 'react-native';
import { CircleCheck } from 'lucide-react-native';
import type { OutcomeBlock } from '@/lib/transcript';
import { colors, mono } from '@/lib/theme';

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function Row({ label, value, monospace }: { label: string; value?: string; monospace?: boolean }) {
  if (!value) return null;
  return (
    <View style={{ marginTop: 6 }}>
      <Text style={{ color: colors.textMuted, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</Text>
      <Text style={{ color: colors.text, fontSize: 13, fontFamily: monospace ? mono : undefined }}>{value}</Text>
    </View>
  );
}

/** End-of-task summary, as on the desktop. */
export function OutcomeCard({ block }: { block: OutcomeBlock }) {
  const stats = [
    formatDuration(block.durationMs),
    `${block.toolCalls} step${block.toolCalls === 1 ? '' : 's'}`,
    block.approvals ? `${block.approvals} approval${block.approvals === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <View style={{ borderRadius: 12, borderWidth: 1, borderColor: colors.accentBorder, backgroundColor: colors.accentBg, padding: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <CircleCheck size={16} color={colors.success} />
        <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600', flex: 1 }}>{block.title}</Text>
      </View>
      <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>{stats}</Text>
      {block.summary ? <Text style={{ color: colors.text, fontSize: 13, marginTop: 8 }}>{block.summary}</Text> : null}
      <Row label="Cause" value={block.cause} />
      <Row label="Fix" value={block.fix} />
      <Row label="Verified" value={block.verified} />
      <Row label="Undo" value={block.undoCommand} monospace />
      <Row label="Learned" value={block.learnedNote} />
    </View>
  );
}
