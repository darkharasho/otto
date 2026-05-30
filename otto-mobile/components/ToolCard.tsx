import { useState } from 'react';
import { View, Text, Pressable, ScrollView, Platform } from 'react-native';
import { ChevronDown } from 'lucide-react-native';
import { ToolIcon } from './ToolIcon';
import { describeTool, summarizeInput, classifyResult, type ResultView } from '@/lib/tool-presenters';
import { EmojiText } from './EmojiText';

type ToolStatus = 'pending' | 'resolved' | 'denied';

interface Props {
  name: string;
  input: unknown;
  status: ToolStatus;
  result?: unknown;
  isError?: boolean;
}

function ResultRenderer({ view }: { view: ResultView }) {
  switch (view.kind) {
    case 'empty':
      return null;
    case 'terminal': {
      const exit = view.exitCode;
      const exitColor = exit === undefined ? '#71717a' : exit === 0 ? '#10b981' : '#ef4444';
      return (
        <View style={{ borderRadius: 4, backgroundColor: 'rgba(13,13,14,0.6)', padding: 8 }}>
          {view.stdout ? <Text style={{ fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 10, color: '#e4e4e7' }}>{view.stdout}</Text> : null}
          {view.stderr ? <Text style={{ fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 10, color: '#ef4444' }}>{view.stderr}</Text> : null}
          {exit !== undefined && (
            <Text style={{ color: exitColor, fontSize: 10, marginTop: 4 }}>
              {'↳'} exited {exit}
            </Text>
          )}
        </View>
      );
    }
    case 'kv':
      return (
        <View>
          {view.entries.map(([k, v]) => (
            <View key={k} style={{ flexDirection: 'row', gap: 8, marginBottom: 2 }}>
              <Text style={{ fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 10, color: '#71717a' }}>{k}</Text>
              <EmojiText style={{ fontFamily: 'monospace', fontSize: 10, color: '#e4e4e7', flex: 1 }} iconSize={10}>{v}</EmojiText>
            </View>
          ))}
        </View>
      );
    case 'error':
      return (
        <View style={{ borderRadius: 4, borderWidth: 1, borderColor: 'rgba(239,68,68,0.4)', backgroundColor: 'rgba(239,68,68,0.1)', paddingHorizontal: 8, paddingVertical: 6 }}>
          <Text style={{ color: '#ef4444', fontSize: 11 }}>{view.text}</Text>
        </View>
      );
    case 'markdown':
      return <EmojiText style={{ fontSize: 11, color: '#e4e4e7' }} iconSize={11}>{view.text}</EmojiText>;
    case 'json':
      return (
        <ScrollView horizontal style={{ borderRadius: 4, backgroundColor: 'rgba(13,13,14,0.6)', padding: 8 }}>
          <Text style={{ fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 10, color: '#e4e4e7' }}>
            {JSON.stringify(view.value, null, 2)}
          </Text>
        </ScrollView>
      );
    case 'image':
      return <Text style={{ fontSize: 11, color: '#71717a', fontStyle: 'italic' }}>[image]</Text>;
  }
}

export function ToolCard({ name, input, status, result, isError }: Props) {
  const [open, setOpen] = useState(false);
  const resolvedStatus =
    status === 'pending' ? 'running'
    : status === 'denied' ? 'denied'
    : isError ? 'error'
    : 'done';
  const statusLabel = resolvedStatus === 'running' ? '...' : resolvedStatus;
  const statusColor =
    resolvedStatus === 'running' ? '#71717a'
    : resolvedStatus === 'done' ? '#10b981'
    : '#ef4444';

  const desc = describeTool(name);
  const summary = summarizeInput(name, input);
  const view = result === undefined ? null : classifyResult(name, result, Boolean(isError));

  return (
    <View style={{ borderRadius: 8, borderWidth: 1, borderColor: '#2a2a2e', backgroundColor: '#1a1a1c', overflow: 'hidden' }}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 10, paddingVertical: 8, minHeight: 44 }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
          <View style={{ width: 20, height: 20, borderRadius: 4, backgroundColor: 'rgba(99,102,241,0.1)', alignItems: 'center', justifyContent: 'center' }}>
            <ToolIcon name={desc.icon} size={12} />
          </View>
          <View style={{ minWidth: 0, flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
              {desc.group ? (
                <Text style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.5, color: '#71717a', fontWeight: '600' }}>{desc.group}</Text>
              ) : null}
              <Text style={{ fontWeight: '600', fontSize: 12, color: '#e4e4e7' }} numberOfLines={1}>{desc.label}</Text>
            </View>
            {summary ? (
              <Text style={{ fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 10, color: '#71717a' }} numberOfLines={1}>{summary}</Text>
            ) : null}
          </View>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 8 }}>
          <Text style={{ color: statusColor, textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 10 }}>
            {statusLabel}
          </Text>
          <ChevronDown
            size={12}
            color="#71717a"
            style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}
          />
        </View>
      </Pressable>
      {open && (
        <View style={{ paddingHorizontal: 10, paddingBottom: 10, borderTopWidth: 1, borderTopColor: 'rgba(42,42,46,0.4)', paddingTop: 8, gap: 8 }}>
          {input !== undefined && input !== null && (
            <View>
              <Text style={{ color: '#71717a', marginBottom: 4, fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.5 }}>Input</Text>
              <ScrollView horizontal style={{ backgroundColor: 'rgba(13,13,14,0.6)', borderRadius: 4, padding: 8 }}>
                <Text style={{ fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 10, color: '#e4e4e7' }}>
                  {JSON.stringify(input, null, 2)}
                </Text>
              </ScrollView>
            </View>
          )}
          {view && view.kind !== 'empty' && (
            <View>
              <Text style={{ color: '#71717a', marginBottom: 4, fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.5 }}>Result</Text>
              <ResultRenderer view={view} />
            </View>
          )}
        </View>
      )}
    </View>
  );
}
