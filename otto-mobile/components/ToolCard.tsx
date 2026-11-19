import { useState } from 'react';
import { View, Text, Pressable, ScrollView, Linking } from 'react-native';
import { ChevronDown } from 'lucide-react-native';
import { describeTool, summarizeInput, classifyResult, type ResultView } from '@shared/tool-presenters';
import type { ToolStatus } from '@/lib/transcript';
import { colors, mono } from '@/lib/theme';
import { ToolIcon } from './ToolIcon';
import { EmojiText } from './EmojiText';

interface Props {
  name: string;
  input: unknown;
  status: ToolStatus;
  result?: unknown;
  isError?: boolean;
  /** Live output while it runs. */
  output?: string;
  takeaway?: string;
  why?: string;
  deniedReason?: string;
}

const small = { fontSize: 10, color: colors.text, fontFamily: mono } as const;
const label = { color: colors.textMuted, marginBottom: 4, fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.5 } as const;

function Mono({ children, color = colors.text }: { children: string; color?: string }) {
  return (
    <ScrollView horizontal style={{ borderRadius: 4, backgroundColor: colors.well, padding: 8 }}>
      <Text style={{ ...small, color }}>{children}</Text>
    </ScrollView>
  );
}

function Lines({ lines }: { lines: string[] }) {
  return (
    <View style={{ gap: 2 }}>
      {lines.map((l, i) => <Text key={i} style={small} numberOfLines={2}>{l}</Text>)}
    </View>
  );
}

function ResultRenderer({ view }: { view: ResultView }) {
  switch (view.kind) {
    case 'empty':
      return null;
    case 'terminal': {
      const exit = view.exitCode;
      return (
        <View style={{ borderRadius: 4, backgroundColor: colors.well, padding: 8 }}>
          {view.stdout ? <Text style={small}>{view.stdout.slice(-4000)}</Text> : null}
          {view.stderr ? <Text style={{ ...small, color: colors.danger }}>{view.stderr.slice(-2000)}</Text> : null}
          {exit !== undefined && (
            <Text style={{ color: exit === 0 ? colors.success : colors.danger, fontSize: 10, marginTop: 4 }}>exited {exit}</Text>
          )}
        </View>
      );
    }
    case 'kv':
      return (
        <View>
          {view.entries.map(([k, v]) => (
            <View key={k} style={{ flexDirection: 'row', gap: 8, marginBottom: 2 }}>
              <Text style={{ ...small, color: colors.textMuted }}>{k}</Text>
              <EmojiText style={{ ...small, flex: 1 }} iconSize={10}>{v}</EmojiText>
            </View>
          ))}
        </View>
      );
    case 'error':
      return (
        <View style={{ borderRadius: 4, borderWidth: 1, borderColor: colors.dangerBorder, backgroundColor: colors.dangerBg, paddingHorizontal: 8, paddingVertical: 6 }}>
          <Text style={{ color: colors.danger, fontSize: 11 }}>{view.text}</Text>
          {view.suggestion ? <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 4 }}>{view.suggestion}</Text> : null}
        </View>
      );
    case 'markdown':
      return <EmojiText style={{ fontSize: 11, color: colors.text }} iconSize={11}>{view.text}</EmojiText>;
    case 'code':
    case 'notebook':
      return <Mono>{view.text.slice(0, 6000)}</Mono>;
    case 'diff':
      return (
        <ScrollView horizontal style={{ borderRadius: 4, backgroundColor: colors.well, padding: 8 }}>
          <View>
            <Text style={{ ...small, color: colors.textMuted }}>{view.path}  +{view.added} −{view.removed}</Text>
            {view.hunks.flatMap((h) => h.lines).slice(0, 300).map((l, i) => (
              <Text key={i} style={{ ...small, color: l.kind === 'add' ? colors.success : l.kind === 'del' ? colors.danger : colors.textMuted }}>
                {(l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  ') + l.text}
              </Text>
            ))}
          </View>
        </ScrollView>
      );
    case 'paths':
      return <Lines lines={view.matches.slice(0, 50)} />;
    case 'matches':
      return <Lines lines={view.files.slice(0, 50).map((f) => `${f.path}:${f.line}  ${f.snippet}`)} />;
    case 'search':
      return (
        <View style={{ gap: 6 }}>
          {view.results.slice(0, 8).map((r) => (
            <Pressable key={r.url} onPress={() => void Linking.openURL(r.url)}>
              <Text style={{ color: colors.accent, fontSize: 11 }} numberOfLines={1}>{r.title}</Text>
              {r.snippet ? <Text style={{ color: colors.textMuted, fontSize: 10 }} numberOfLines={2}>{r.snippet}</Text> : null}
            </Pressable>
          ))}
        </View>
      );
    case 'page':
      return (
        <Pressable onPress={() => void Linking.openURL(view.url)}>
          <Text style={{ color: colors.accent, fontSize: 11 }} numberOfLines={1}>{view.title ?? view.url}</Text>
          {view.snippet ? <Text style={{ color: colors.textMuted, fontSize: 10 }} numberOfLines={4}>{view.snippet}</Text> : null}
        </Pressable>
      );
    case 'github':
      return (
        <Pressable onPress={() => view.htmlUrl && void Linking.openURL(view.htmlUrl)}>
          <Text style={{ color: colors.text, fontSize: 11 }}>
            {view.repo}{view.number !== undefined ? ` #${view.number}` : ''}{view.title ? ` — ${view.title}` : ''}
          </Text>
          {view.state ? <Text style={{ color: colors.textMuted, fontSize: 10 }}>{view.state}</Text> : null}
        </Pressable>
      );
    case 'tasks':
      return <Lines lines={view.items.map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '•' : '○'} ${t.title}`)} />;
    case 'click':
      return <Text style={small}>{`${view.button ?? 'left'} click at ${view.x}, ${view.y}`}</Text>;
    case 'keypress':
      return <Text style={small}>{view.keys.join(' + ')}</Text>;
    case 'typed':
      return <Text style={small}>{view.text}</Text>;
    case 'observe':
      return (
        <View>
          <Text style={{ ...small, color: colors.textMuted }}>{`${view.label} (${view.unit}), ${view.series.length} samples`}</Text>
          {view.verdict ? <Text style={{ fontSize: 11, color: view.verdict.ok ? colors.success : colors.danger }}>{view.verdict.text}</Text> : null}
        </View>
      );
    case 'image':
      return <Text style={{ fontSize: 11, color: colors.textMuted, fontStyle: 'italic' }}>{view.note ?? 'Screenshot (shown on the desktop)'}</Text>;
    case 'tree':
    case 'delegation':
    case 'json':
    default:
      return <Mono>{JSON.stringify('value' in view ? view.value : view, null, 2).slice(0, 6000)}</Mono>;
  }
}

export function ToolCard({ name, input, status, result, isError, output, takeaway, why, deniedReason }: Props) {
  const [open, setOpen] = useState(false);
  const state = status === 'pending' ? 'running' : status === 'denied' ? 'denied' : isError ? 'error' : 'done';
  const stateColor = state === 'running' ? colors.textMuted : state === 'done' ? colors.success : colors.danger;
  const desc = describeTool(name, input);
  const summary = summarizeInput(name, input);
  const view = result === undefined ? null : classifyResult(name, result, Boolean(isError), input);
  const note = state === 'denied' ? deniedReason : isError ? why ?? takeaway : takeaway;

  // Low-signal tools (memory, file reads) get a one-line receipt.
  if (desc.quiet && state === 'done') {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 }}>
        <ToolIcon name={desc.icon} size={11} color={colors.textMuted} />
        <Text style={{ color: colors.textMuted, fontSize: 11 }} numberOfLines={1}>
          {desc.label}{summary ? ` · ${summary}` : ''}
        </Text>
      </View>
    );
  }

  return (
    <View style={{ borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, overflow: 'hidden' }}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 10, paddingVertical: 8, minHeight: 44 }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
          <View style={{ width: 20, height: 20, borderRadius: 4, backgroundColor: colors.accentBg, alignItems: 'center', justifyContent: 'center' }}>
            <ToolIcon name={desc.icon} size={12} />
          </View>
          <View style={{ minWidth: 0, flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
              {desc.group ? (
                <Text style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.5, color: colors.textMuted, fontWeight: '600' }}>{desc.group}</Text>
              ) : null}
              <Text style={{ fontWeight: '600', fontSize: 12, color: colors.text }} numberOfLines={1}>{desc.label}</Text>
            </View>
            {summary ? <Text style={{ ...small, color: colors.textMuted }} numberOfLines={1}>{summary}</Text> : null}
          </View>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 8 }}>
          <Text style={{ color: stateColor, textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 10 }}>
            {state === 'running' ? '...' : state}
          </Text>
          <ChevronDown size={12} color={colors.textMuted} style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }} />
        </View>
      </Pressable>
      {note ? (
        <Text style={{ color: state === 'done' ? colors.textDim : colors.danger, fontSize: 11, paddingHorizontal: 10, paddingBottom: 8, marginTop: -4 }}>{note}</Text>
      ) : null}
      {state === 'running' && output ? (
        <View style={{ paddingHorizontal: 10, paddingBottom: 10 }}>
          <Text style={small} numberOfLines={6}>{output.slice(-600)}</Text>
        </View>
      ) : null}
      {open && (
        <View style={{ paddingHorizontal: 10, paddingBottom: 10, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8, gap: 8 }}>
          {input !== undefined && input !== null && (
            <View>
              <Text style={label}>Input</Text>
              <Mono>{JSON.stringify(input, null, 2)}</Mono>
            </View>
          )}
          {view && view.kind !== 'empty' && (
            <View>
              <Text style={label}>Result</Text>
              <ResultRenderer view={view} />
            </View>
          )}
        </View>
      )}
    </View>
  );
}
