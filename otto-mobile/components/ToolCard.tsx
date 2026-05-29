import { useState } from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
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
        <View className="rounded bg-bg/60 p-2">
          {view.stdout ? <Text className="font-mono text-[10px] text-text">{view.stdout}</Text> : null}
          {view.stderr ? <Text className="font-mono text-[10px] text-danger">{view.stderr}</Text> : null}
          {exit !== undefined && (
            <Text style={{ color: exitColor }} className="text-[10px] mt-1">
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
            <View key={k} className="flex-row gap-2 mb-0.5">
              <Text className="font-mono text-[10px] text-muted">{k}</Text>
              <EmojiText style={{ fontFamily: 'monospace', fontSize: 10, color: '#e4e4e7', flex: 1 }} iconSize={10}>{v}</EmojiText>
            </View>
          ))}
        </View>
      );
    case 'error':
      return (
        <View className="rounded border border-danger/40 bg-danger/10 px-2 py-1.5">
          <Text className="text-danger text-[11px]">{view.text}</Text>
        </View>
      );
    case 'markdown':
      return <EmojiText style={{ fontSize: 11, color: '#e4e4e7' }} iconSize={11}>{view.text}</EmojiText>;
    case 'json':
      return (
        <ScrollView horizontal className="rounded bg-bg/60 p-2">
          <Text className="font-mono text-[10px] text-text">
            {JSON.stringify(view.value, null, 2)}
          </Text>
        </ScrollView>
      );
    case 'image':
      return <Text className="text-[11px] text-muted italic">[image]</Text>;
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
    <View className="rounded-lg border border-border bg-surface overflow-hidden">
      <Pressable
        onPress={() => setOpen((v) => !v)}
        className="flex-row items-center justify-between px-2.5 py-2"
        style={{ minHeight: 44 }}
      >
        <View className="flex-row items-center gap-2 flex-1 min-w-0">
          <View className="w-5 h-5 rounded bg-accent/10 items-center justify-center">
            <ToolIcon name={desc.icon} size={12} />
          </View>
          <View className="min-w-0 flex-1">
            <View className="flex-row items-baseline gap-1.5">
              {desc.group ? (
                <Text className="text-[9px] uppercase tracking-wide text-muted font-semibold">{desc.group}</Text>
              ) : null}
              <Text className="font-semibold text-xs text-text" numberOfLines={1}>{desc.label}</Text>
            </View>
            {summary ? (
              <Text className="font-mono text-[10px] text-muted" numberOfLines={1}>{summary}</Text>
            ) : null}
          </View>
        </View>
        <View className="flex-row items-center gap-1.5 ml-2">
          <Text style={{ color: statusColor }} className="uppercase tracking-wide text-[10px]">
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
        <View className="px-2.5 pb-2.5 border-t border-border/40 pt-2 gap-2">
          {input !== undefined && input !== null && (
            <View>
              <Text className="text-muted mb-1 text-[9px] uppercase tracking-wide">Input</Text>
              <ScrollView horizontal className="bg-bg/60 rounded p-2">
                <Text className="font-mono text-[10px] text-text">
                  {JSON.stringify(input, null, 2)}
                </Text>
              </ScrollView>
            </View>
          )}
          {view && view.kind !== 'empty' && (
            <View>
              <Text className="text-muted mb-1 text-[9px] uppercase tracking-wide">Result</Text>
              <ResultRenderer view={view} />
            </View>
          )}
        </View>
      )}
    </View>
  );
}
