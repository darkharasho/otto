import { useState } from 'react';
import { View, Text, Pressable, ScrollView, Platform } from 'react-native';
import { ChevronDown } from 'lucide-react-native';
import { ToolIcon } from './ToolIcon';
import { describeTool, summarizeInput, classifyResult, type ResultView, type DelegationSnapshotView } from '@/lib/tool-presenters';
import { EmojiText } from './EmojiText';

type ToolStatus = 'pending' | 'resolved' | 'denied';

interface Props {
  name: string;
  input: unknown;
  status: ToolStatus;
  result?: unknown;
  isError?: boolean;
  /** Latest partial-result snapshot while the call is still running. */
  snapshot?: unknown;
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
    case 'delegation':
      return <DelegationRenderer snapshot={view.snapshot} />;
  }
}

const DELEGATION_STATUS_LABEL: Record<string, string> = {
  connecting: 'Connecting',
  busy: 'Busy',
  running: 'Working',
  done: 'Done',
  interrupted: 'Interrupted',
  error: 'Error',
  lost: 'Connection lost',
};

const DELEGATION_DOT: Record<string, string> = {
  running: '#6366f1',
  done: '#10b981',
  error: '#ef4444',
  denied: '#f5a04b',
};

/**
 * The other machine's transcript. Approvals it raises can only be answered on
 * the desktop that delegated the task, so they show here as a waiting note.
 */
function DelegationRenderer({ snapshot }: { snapshot: DelegationSnapshotView }) {
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text style={{ fontSize: 11, fontWeight: '600', color: '#e4e4e7' }}>{snapshot.machine}</Text>
        <Text style={{ fontSize: 11, color: '#71717a' }}>
          {DELEGATION_STATUS_LABEL[snapshot.status] ?? snapshot.status}
        </Text>
      </View>
      {snapshot.items.map((it, i) =>
        it.kind === 'text' ? (
          <EmojiText key={i} style={{ fontSize: 11, color: '#e4e4e7' }} iconSize={11}>{it.text}</EmojiText>
        ) : (
          <View key={it.callId || String(i)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: DELEGATION_DOT[it.status] ?? '#71717a' }} />
            <Text style={{ fontSize: 11, fontWeight: '500', color: '#e4e4e7' }}>{describeTool(it.name).label}</Text>
            <Text
              style={{ fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 10, color: '#71717a', flex: 1 }}
              numberOfLines={1}
            >
              {it.summary}
            </Text>
          </View>
        )
      )}
      {snapshot.pendingApproval ? (
        <Text style={{ fontSize: 10.5, color: '#f5a04b' }}>
          Waiting for approval of {describeTool(snapshot.pendingApproval.name).label} on {snapshot.machine}.
        </Text>
      ) : null}
      {snapshot.pendingSudo ? (
        <Text style={{ fontSize: 10.5, color: '#f5a04b' }}>Waiting for a password on {snapshot.machine}.</Text>
      ) : null}
      {snapshot.error ? <Text style={{ fontSize: 11, color: '#ef4444' }}>{snapshot.error}</Text> : null}
    </View>
  );
}

export function ToolCard({ name, input, status, result, isError, snapshot }: Props) {
  const [override, setOverride] = useState<boolean | null>(null);
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
  // While the call is open, its latest snapshot stands in for the result — a
  // delegation renders the other machine's transcript as it arrives.
  const view = result === undefined
    ? (snapshot === undefined ? null : classifyResult(name, snapshot, false))
    : classifyResult(name, result, Boolean(isError));
  // A live card opens itself so remote progress needs no tap; once the user
  // toggles it, their choice sticks.
  const open = override ?? (resolvedStatus === 'running' && view !== null && view.kind !== 'empty');

  return (
    <View style={{ borderRadius: 8, borderWidth: 1, borderColor: '#2a2a2e', backgroundColor: '#1a1a1c', overflow: 'hidden' }}>
      <Pressable
        onPress={() => setOverride(!open)}
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
