import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, TextInput, Pressable, FlatList, AppState, Alert,
  KeyboardAvoidingView, Platform, Image, Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Menu, Send, Square, Paperclip } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import Markdown from 'react-native-markdown-display';
import { useAppStore } from '@/lib/store';
import { MachineConnection } from '@/lib/connection';
import { getHistory, loadMessages, userUploadUrl } from '@/lib/wire';
import { summarizeInput } from '@/lib/tool-presenters';
import { splitEmoji, hasEmojiIcon } from '@/lib/emoji-icons';
import { FluentEmoji } from '@/components/FluentEmoji';
import { extFromMime, type ImageRef, type ImageMimeType } from '@/lib/types';
import { ApprovalCard } from '@/components/ApprovalCard';
import { ToolCard } from '@/components/ToolCard';
import { Screenshot } from '@/components/Screenshot';
import { SessionDrawer } from '@/components/SessionDrawer';
import { TypingDots } from '@/components/TypingDots';
import { OttoMark } from '@/components/OttoMark';

// --- Transcript item types (mirrors PWA) ---

type ToolStatus = 'pending' | 'resolved' | 'denied';

interface TextItem { kind: 'text'; id: string; text: string; done: boolean }
interface ToolItem { kind: 'tool'; id: string; callId: string; name: string; input: unknown; status: ToolStatus; result?: unknown; isError?: boolean }
interface ScreenshotItem { kind: 'screenshot'; id: string; shotId: string; signedUrl: string }
interface UserItem { kind: 'user'; id: string; text: string; content?: Array<{ type: string; [k: string]: unknown }> }
type TranscriptItem = TextItem | ToolItem | ScreenshotItem | UserItem;

interface PendingApproval { decisionId: string; tool: string; actionClass: string; summary: string }

function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// --- Markdown styles ---

const mdStyles = {
  body: { color: '#e4e4e7', fontSize: 14 },
  paragraph: { marginTop: 2, marginBottom: 2 },
  heading1: { color: '#e4e4e7', fontSize: 16, fontWeight: '600' as const, marginTop: 8, marginBottom: 4 },
  heading2: { color: '#e4e4e7', fontSize: 15, fontWeight: '600' as const, marginTop: 8, marginBottom: 4 },
  heading3: { color: '#e4e4e7', fontSize: 14, fontWeight: '600' as const, marginTop: 8, marginBottom: 4 },
  code_inline: { backgroundColor: '#1a1a1c', color: '#e4e4e7', paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4, fontSize: 13 },
  code_block: { backgroundColor: '#1a1a1c', color: '#e4e4e7', padding: 8, borderRadius: 8, fontSize: 12 },
  fence: { backgroundColor: '#1a1a1c', color: '#e4e4e7', padding: 8, borderRadius: 8, fontSize: 12 },
  link: { color: '#6366f1' },
  blockquote: { borderLeftColor: '#2a2a2e', borderLeftWidth: 2, paddingLeft: 8, marginVertical: 4 },
  bullet_list: { marginVertical: 2 },
  ordered_list: { marginVertical: 2 },
  list_item: { marginVertical: 1 },
  hr: { backgroundColor: '#2a2a2e', height: 1 },
  table: { borderColor: '#2a2a2e' },
  th: { borderColor: '#2a2a2e', padding: 4 },
  td: { borderColor: '#2a2a2e', padding: 4 },
};

// Custom render rules: replace mapped emoji with inline Lucide icons.
// SVG icons can't nest inside <Text>, so we override textgroup to use a
// flex-row <View> when the content contains emoji.
const mdRules = {
  textgroup: (node: any, children: any, _parent: any, styles: any) => {
    // Check if any child text node contains a mapped emoji.
    const hasEmoji = node.children?.some(
      (c: any) => c.type === 'text' && typeof c.content === 'string' && hasEmojiIcon(c.content),
    );
    if (!hasEmoji) {
      // Normal path: render as <Text> so inline styling (bold, italic) inherits.
      return (
        <Text key={node.key} style={styles.textgroup}>
          {children}
        </Text>
      );
    }
    // Emoji path: rebuild children mixing <Text>, Lucide <Svg>, and Fluent CDN
    // icons in a flex-row <View>.
    const elements: React.ReactNode[] = [];
    let k = 0;
    node.children.forEach((child: any, idx: number) => {
      if (child.type === 'text' && typeof child.content === 'string' && hasEmojiIcon(child.content)) {
        const segs = splitEmoji(child.content);
        for (const seg of segs) {
          if (seg.type === 'text') {
            elements.push(
              <Text key={k++} style={[styles.text, { color: '#e4e4e7', fontSize: 14 }]}>
                {seg.value}
              </Text>,
            );
          } else if (seg.type === 'lucide') {
            const { Icon } = seg;
            elements.push(
              <Icon key={k++} size={14} color="#6366f1" strokeWidth={2.25} />,
            );
          } else {
            // fluent — load monochrome SVG from Iconify CDN
            elements.push(
              <FluentEmoji key={k++} url={seg.url} size={14} color="#6366f1" />,
            );
          }
        }
      } else {
        // Non-emoji children (bold, code, etc.) — use the pre-rendered element.
        elements.push(children[idx]);
      }
    });
    return (
      <View
        key={node.key}
        style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}
      >
        {elements}
      </View>
    );
  },
};

export default function ChatScreen() {
  const { machineId } = useLocalSearchParams<{ machineId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const machine = useAppStore((s) => s.getMachine(machineId));
  const updateMachine = useAppStore((s) => s.updateMachine);

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardWillShow', () => {
      setKeyboardVisible(true);
      // Scroll twice: once during animation, once after layout settles
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 250);
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 500);
    });
    const hideSub = Keyboard.addListener('keyboardWillHide', () => setKeyboardVisible(false));
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [queueDepth, setQueueDepth] = useState(0);
  const busy = streaming || queueDepth > 0;
  const [connected, setConnected] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [input, setInput] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [deviceLabel, setDeviceLabel] = useState<string | null>(null);
  const [pendingUploads, setPendingUploads] = useState<Array<{ correlationId: string; mimeType: string }>>([]);
  const [confirmedAttachments, setConfirmedAttachments] = useState<ImageRef[]>([]);

  const connRef = useRef<MachineConnection | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const lastSeqRef = useRef(0);
  const currentTextIdRef = useRef<string | null>(null);
  const flatListRef = useRef<FlatList>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearWatchdog = () => {
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
  };
  const armWatchdog = () => {
    clearWatchdog();
    watchdogRef.current = setTimeout(() => {
      setStreaming(false);
      setErrorMsg('No response from Otto — try again.');
    }, 30_000);
  };

  const resetForSession = useCallback((newSid: string) => {
    setItems([]);
    setApprovals([]);
    lastSeqRef.current = 0;
    sessionIdRef.current = newSid;
    setSessionId(newSid);
    currentTextIdRef.current = null;
    setStreaming(false);
    clearWatchdog();
    setErrorMsg(null);
  }, []);

  const backfillMessages = useCallback(async (sid: string) => {
    if (!machine) return;
    try {
      const { messages } = await loadMessages(machine.baseUrl, machine.token, sid);
      const built: TranscriptItem[] = [];
      for (const raw of messages) {
        const role = String((raw as { role?: unknown }).role ?? '');
        const content = ((raw as { content?: unknown }).content ?? []) as Array<Record<string, unknown>>;
        const idBase = String((raw as { id?: unknown }).id ?? newId());
        if (role === 'user') {
          const text = content
            .filter((b) => b.type === 'text' && typeof b.text === 'string')
            .map((b) => String(b.text))
            .join('');
          const hasContent = text || content.some((b) => b.type === 'image-ref');
          const typedContent = content as Array<{ type: string; [k: string]: unknown }>;
          if (hasContent) built.push({ kind: 'user', id: idBase, text, content: typedContent });
          continue;
        }
        if (role === 'assistant') {
          let textBuf = '';
          for (const block of content) {
            const t = block.type;
            if (t === 'text' && typeof block.text === 'string') {
              textBuf += String(block.text);
            } else if (t === 'tool_use') {
              if (textBuf) { built.push({ kind: 'text', id: `${idBase}-t-${built.length}`, text: textBuf, done: true }); textBuf = ''; }
              const callId = String(block.callId ?? '');
              built.push({ kind: 'tool', id: `${idBase}-tu-${callId || built.length}`, callId, name: String(block.name ?? ''), input: block.input, status: 'pending' });
            } else if (t === 'tool_result') {
              const callId = String(block.callId ?? '');
              const idx = built.findIndex((it) => it.kind === 'tool' && it.callId === callId);
              if (idx !== -1) {
                const it = built[idx] as ToolItem;
                built[idx] = { ...it, status: 'resolved', result: block.result, isError: Boolean(block.isError) };
              }
            }
          }
          if (textBuf) built.push({ kind: 'text', id: `${idBase}-t-${built.length}`, text: textBuf, done: true });
        }
      }
      setItems(built);
      // Scroll after FlatList renders the new items
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: false }), 200);
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: false }), 600);
    } catch { /* best-effort */ }
  }, [machine]);

  // --- Event handler (mirrors PWA handleEvent) ---

  const handleEvent = useCallback((msg: { type: string; [k: string]: unknown }) => {
    if (msg.type === 'pong') return;
    if (msg.type === 'session_switched' && typeof msg.sessionId === 'string') {
      const sid = msg.sessionId;
      resetForSession(sid);
      void backfillMessages(sid);
      return;
    }
    if (msg.type === 'error') {
      clearWatchdog();
      setStreaming(false);
      setErrorMsg(typeof msg.message === 'string' ? msg.message : 'error');
      return;
    }
    if (msg.type === 'attach_ok') {
      const cid = typeof msg.clientCorrelationId === 'string' ? msg.clientCorrelationId : '';
      const ref = msg.ref as ImageRef;
      setPendingUploads((p) => p.filter((u) => u.correlationId !== cid));
      setConfirmedAttachments((c) => [...c, ref]);
      return;
    }
    if (msg.type === 'attach_err') {
      const cid = typeof msg.clientCorrelationId === 'string' ? msg.clientCorrelationId : '';
      setPendingUploads((p) => p.filter((u) => u.correlationId !== cid));
      return;
    }
    if (msg.type !== 'event') return;
    const kind = msg.kind as string;
    const sid = msg.sessionId as string | undefined;
    if (sid && sid !== sessionIdRef.current) {
      sessionIdRef.current = sid;
      setSessionId(sid);
    }
    clearWatchdog();

    switch (kind) {
      case 'user-message': {
        const id = String(msg.messageId ?? newId());
        const text = String(msg.text ?? '');
        const content = Array.isArray(msg.content) ? (msg.content as Array<{ type: string; [k: string]: unknown }>) : undefined;
        setItems((prev) => prev.some((it) => it.id === id) ? prev : [...prev, { kind: 'user', id, text, content }]);
        return;
      }
      case 'user-message-queued':
      case 'user-message-consumed': {
        setQueueDepth(typeof msg.queueDepth === 'number' ? msg.queueDepth : 0);
        return;
      }
      case 'message-start': {
        const id = newId();
        currentTextIdRef.current = id;
        setItems((prev) => [...prev, { kind: 'text', id, text: '', done: false }]);
        setStreaming(true);
        return;
      }
      case 'text-delta': {
        const text = typeof msg.text === 'string' ? msg.text : '';
        setItems((prev) => {
          const idx = prev.findIndex((it) => it.kind === 'text' && it.id === currentTextIdRef.current);
          if (idx === -1) {
            const id = newId();
            currentTextIdRef.current = id;
            return [...prev, { kind: 'text', id, text, done: false }];
          }
          const copy = prev.slice();
          const item = copy[idx] as TextItem;
          copy[idx] = { ...item, text: item.text + text };
          return copy;
        });
        return;
      }
      case 'tool-call-start': {
        const callId = String(msg.callId ?? newId());
        const name = String(msg.name ?? '');
        currentTextIdRef.current = null;
        setItems((prev) => {
          const closed = prev.map((it) => it.kind === 'text' && !it.done ? { ...it, done: true } : it);
          return [...closed, { kind: 'tool', id: newId(), callId, name, input: msg.input, status: 'pending' as ToolStatus }];
        });
        return;
      }
      case 'tool-call-result': {
        const callId = String(msg.callId ?? '');
        setItems((prev) => prev.map((it) =>
          it.kind === 'tool' && it.callId === callId
            ? { ...it, status: 'resolved' as ToolStatus, result: msg.result, isError: Boolean(msg.isError) }
            : it
        ));
        return;
      }
      case 'tool-call-denied': {
        const callId = String(msg.callId ?? '');
        setItems((prev) => prev.map((it) =>
          it.kind === 'tool' && it.callId === callId ? { ...it, status: 'denied' as ToolStatus } : it
        ));
        return;
      }
      case 'tool-call-pending': {
        const decisionId = String(msg.decisionId ?? '');
        if (!decisionId) return;
        const tool = String(msg.name ?? '');
        const actionClass = String(msg.actionClass ?? 'reversible');
        const summary = summarizeInput(tool, msg.input) ?? '';
        setApprovals((prev) => prev.some((p) => p.decisionId === decisionId) ? prev : [...prev, { decisionId, tool, actionClass, summary }]);
        return;
      }
      case 'tool-call-decided': {
        const decisionId = String(msg.decisionId ?? '');
        setApprovals((prev) => prev.filter((p) => p.decisionId !== decisionId));
        return;
      }
      case 'screenshot-captured': {
        const id = String(msg.id ?? '');
        const signedUrl = typeof msg.signedUrl === 'string' ? msg.signedUrl : '';
        if (id && signedUrl) {
          setItems((prev) => [...prev, { kind: 'screenshot', id: newId(), shotId: id, signedUrl }]);
        }
        return;
      }
      case 'message-end':
      case 'done': {
        setStreaming(false);
        setItems((prev) => prev.map((it) => it.kind === 'text' && !it.done ? { ...it, done: true } : it));
        currentTextIdRef.current = null;
        return;
      }
    }
  }, [resetForSession, backfillMessages]);

  // --- Connection lifecycle ---
  // Store handleEvent in a ref so the connection effect doesn't re-run on every render.
  const handleEventRef = useRef(handleEvent);
  handleEventRef.current = handleEvent;
  const updateMachineRef = useRef(updateMachine);
  updateMachineRef.current = updateMachine;

  useEffect(() => {
    if (!machine) return;

    const conn = new MachineConnection(machine.baseUrl, machine.token, {
      onAuthOk: (label) => {
        setDeviceLabel(label);
        updateMachineRef.current(machine.id, { lastSeen: Date.now() });
        const sid = sessionIdRef.current;
        if (sid) {
          getHistory(machine.baseUrl, machine.token, sid, lastSeqRef.current)
            .then((h) => {
              for (const entry of h.events) {
                lastSeqRef.current = Math.max(lastSeqRef.current, entry.seq);
                if (entry.event && typeof entry.event === 'object') {
                  handleEventRef.current(entry.event as { type: string });
                }
              }
            })
            .catch(() => {});
        }
      },
      onEvent: (e) => handleEventRef.current(e),
      onConnected: () => { setConnected(true); setUnreachable(false); },
      onDisconnected: () => { setConnected(false); },
      onUnreachable: () => { setUnreachable(true); },
      onBaseUrlChanged: (newBaseUrl) => {
        updateMachineRef.current(machine.id, { baseUrl: newBaseUrl });
      },
    });

    connRef.current = conn;
    conn.connect();

    // Reconnect when app comes back from background
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !conn.connected) {
        conn.connect();
      }
    });

    return () => {
      sub.remove();
      conn.disconnect();
      connRef.current = null;
      clearWatchdog();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine?.id, machine?.baseUrl, machine?.token]);

  // Auto-scroll
  useEffect(() => {
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
  }, [items.length, approvals.length]);

  if (!machine) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0d0d0e', alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#ef4444' }}>Machine not found</Text>
      </View>
    );
  }

  const onSend = () => {
    const text = input.trim();
    if (!text && confirmedAttachments.length === 0) return;
    if (pendingUploads.length > 0) return;
    connRef.current?.send({
      v: 1,
      type: 'prompt',
      sessionId: sessionIdRef.current ?? '',
      text,
      attachmentIds: confirmedAttachments.length > 0 ? confirmedAttachments.map((r) => r.id) : undefined,
    });
    setInput('');
    setErrorMsg(null);
    setConfirmedAttachments([]);
    setStreaming(true);
    armWatchdog();
  };

  const onStop = () => {
    connRef.current?.send({ v: 1, type: 'interrupt', sessionId: sessionIdRef.current ?? '' });
  };

  const resolveApproval = (decisionId: string, decision: 'approve' | 'deny') => {
    connRef.current?.send({ v: 1, type: 'approval', decisionId, decision });
    setApprovals((prev) => prev.filter((p) => p.decisionId !== decisionId));
  };

  const pickImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
      base64: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    if (!asset.base64) return;
    const mimeType = (asset.mimeType ?? 'image/jpeg') as ImageMimeType;
    const correlationId = newId();
    setPendingUploads((p) => [...p, { correlationId, mimeType }]);
    connRef.current?.send({
      v: 1,
      type: 'attach',
      sessionId: sessionIdRef.current ?? '',
      mimeType: mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
      bytesBase64: asset.base64,
      clientCorrelationId: correlationId,
    });
  };

  const renderItem = ({ item: it, index }: { item: TranscriptItem; index: number }) => {
    const prev = index > 0 ? items[index - 1] : null;
    const showOttoLabel = (it.kind === 'text' || it.kind === 'tool' || it.kind === 'screenshot') &&
      (!prev || prev.kind === 'user');
    if (it.kind === 'user') {
      const imageRefs = (it.content ?? []).filter((b) => b.type === 'image-ref') as ImageRef[];
      return (
        <View style={{ alignItems: 'flex-end', paddingHorizontal: 12, marginBottom: 12 }}>
          <View style={{ borderRadius: 16, backgroundColor: 'rgba(99,102,241,0.2)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.3)', paddingHorizontal: 16, paddingVertical: 8, maxWidth: '80%', borderBottomRightRadius: 6 }}>
            {imageRefs.length > 0 && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
                {imageRefs.map((ref) => (
                  <Image
                    key={ref.id}
                    source={{
                      uri: userUploadUrl(machine.baseUrl, machine.token, ref.sessionId, ref.id, extFromMime(ref.mimeType)),
                    }}
                    style={{ width: 80, height: 80, borderRadius: 8 }}
                    resizeMode="cover"
                  />
                ))}
              </View>
            )}
            {it.text ? (
              <Markdown style={mdStyles} rules={mdRules}>{it.text}</Markdown>
            ) : null}
          </View>
        </View>
      );
    }
    if (it.kind === 'text') {
      if (!it.text) {
        return null; // empty text items — footer "thinking..." indicator handles streaming
      }
      return (
        <View style={{ paddingHorizontal: 12, marginBottom: 12 }}>
          {showOttoLabel && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <OttoMark size={14} color="#6366f1" />
              <Text style={{ color: '#8b8d92', fontSize: 12, fontWeight: '500' }}>Otto</Text>
            </View>
          )}
          <Markdown style={mdStyles} rules={mdRules}>{it.text}</Markdown>
        </View>
      );
    }
    if (it.kind === 'tool') {
      return (
        <View style={{ paddingHorizontal: 12, marginBottom: 8 }}>
          <ToolCard name={it.name} input={it.input} status={it.status} result={it.result} isError={it.isError} />
        </View>
      );
    }
    // screenshot
    return (
      <View style={{ paddingHorizontal: 12, marginBottom: 12 }}>
        <Screenshot
          shotId={it.shotId}
          signedUrl={it.signedUrl}
          baseUrl={machine.baseUrl}
          token={machine.token}
        />
      </View>
    );
  };

  return (
    <>
      <Stack.Screen
        options={{
          header: () => (
            <View style={{ backgroundColor: '#1a1a1c', paddingTop: 54, paddingBottom: 12, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center' }}>
              <Pressable onPress={() => setDrawerOpen(true)} hitSlop={12}>
                <Menu size={22} color="#e4e4e7" />
              </Pressable>
              <Pressable
                onPress={() => {
                  Alert.prompt(
                    'Rename machine',
                    'Enter a new name for this machine.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Save',
                        onPress: (value?: string) => {
                          const trimmed = (value ?? '').trim();
                          if (trimmed && trimmed !== machine.label) updateMachine(machine.id, { label: trimmed });
                        },
                      },
                    ],
                    'plain-text',
                    machine.label,
                  );
                }}
                style={{ flex: 1 }}
              >
                <Text style={{ textAlign: 'center', color: '#e4e4e7', fontSize: 17, fontWeight: '600' }}>{machine.label}</Text>
              </Pressable>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: connected ? '#10b981' : '#f97316' }} />
            </View>
          ),
        }}
      />

      <SessionDrawer
        open={drawerOpen}
        baseUrl={machine.baseUrl}
        token={machine.token}
        currentSessionId={sessionId}
        onClose={() => setDrawerOpen(false)}
        onNewSession={() => {
          connRef.current?.send({ v: 1, type: 'new_session' });
          setDrawerOpen(false);
        }}
        onPickSession={(sid) => {
          connRef.current?.send({ v: 1, type: 'switch_session', sessionId: sid });
          setDrawerOpen(false);
        }}
      />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, backgroundColor: '#0d0d0e' }}
        keyboardVerticalOffset={0}
      >
        {/* Unreachable banner */}
        {unreachable && !connected && (
          <View style={{ paddingHorizontal: 12, paddingVertical: 8, backgroundColor: 'rgba(245,158,11,0.15)', borderBottomWidth: 1, borderBottomColor: 'rgba(245,158,11,0.3)' }}>
            <Text style={{ color: '#fde68a', fontSize: 12, fontWeight: '600' }}>
              Can't reach Otto at {machine.baseUrl.replace(/^https?:\/\//, '')}
            </Text>
            <Text style={{ color: 'rgba(253,230,138,0.8)', fontSize: 12, marginTop: 2 }}>
              Check that Tailscale is online on both devices.
            </Text>
          </View>
        )}

        {/* Approvals */}
        {approvals.length > 0 && (
          <View style={{ paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#0d0d0e', borderBottomWidth: 1, borderBottomColor: '#2a2a2e', gap: 8 }}>
            {approvals.map((a) => (
              <ApprovalCard
                key={a.decisionId}
                decisionId={a.decisionId}
                tool={a.tool}
                actionClass={a.actionClass}
                summary={a.summary}
                onResolve={(d) => resolveApproval(a.decisionId, d)}
              />
            ))}
          </View>
        )}

        {/* Transcript */}
        <FlatList
          ref={flatListRef}
          data={items}
          keyExtractor={(it) => it.id}
          renderItem={renderItem}
          contentContainerStyle={{ paddingTop: 16, paddingBottom: 8 }}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', paddingTop: 64 }}>
              <Text style={{ color: '#71717a', fontSize: 14 }}>
                {connected ? 'Connected. Send a prompt to begin.' : 'Connecting...'}
              </Text>
            </View>
          }
          ListFooterComponent={
            busy ? (
              <View style={{ paddingHorizontal: 12, paddingVertical: 4 }}>
                <TypingDots />
              </View>
            ) : null
          }
        />

        {/* Queue depth */}
        {queueDepth > 0 && (
          <View style={{ paddingHorizontal: 12, paddingVertical: 4, borderTopWidth: 1, borderTopColor: '#2a2a2e', backgroundColor: 'rgba(26,26,28,0.6)' }}>
            <Text style={{ color: '#71717a', fontSize: 11 }}>{queueDepth} queued</Text>
          </View>
        )}

        {/* Error */}
        {errorMsg && (
          <View style={{ paddingHorizontal: 12, paddingVertical: 8, backgroundColor: 'rgba(239,68,68,0.15)', borderTopWidth: 1, borderTopColor: 'rgba(239,68,68,0.4)', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ color: '#ef4444', fontSize: 12, flex: 1 }}>{errorMsg}</Text>
            <Pressable onPress={() => setErrorMsg(null)} hitSlop={8}>
              <Text style={{ color: '#71717a', fontSize: 12, marginLeft: 8 }}>dismiss</Text>
            </Pressable>
          </View>
        )}

        {/* Attachment chips */}
        {(pendingUploads.length > 0 || confirmedAttachments.length > 0) && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, paddingHorizontal: 12, paddingVertical: 4, borderTopWidth: 1, borderTopColor: '#2a2a2e', backgroundColor: '#1a1a1c' }}>
            {confirmedAttachments.map((a) => (
              <View key={a.id} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(13,13,14,0.6)', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, gap: 4 }}>
                <Text style={{ color: '#e4e4e7', fontSize: 10 }}>IMG</Text>
                <Pressable onPress={() => setConfirmedAttachments((s) => s.filter((x) => x.id !== a.id))}>
                  <Text style={{ color: '#71717a', fontSize: 12 }}>x</Text>
                </Pressable>
              </View>
            ))}
            {pendingUploads.map((p) => (
              <View key={p.correlationId} style={{ backgroundColor: 'rgba(13,13,14,0.6)', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, opacity: 0.6 }}>
                <Text style={{ color: '#e4e4e7', fontSize: 10 }}>uploading...</Text>
              </View>
            ))}
          </View>
        )}

        {/* Input bar */}
        <View style={{ backgroundColor: '#1a1a1c' }}>
        <View style={{ borderTopWidth: 1, borderTopColor: '#2a2a2e', backgroundColor: '#1a1a1c', paddingHorizontal: 8, paddingVertical: 8, flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
          <Pressable onPress={pickImage} disabled={!connected} style={{ padding: 8, opacity: connected ? 1 : 0.5 }}>
            <Paperclip size={18} color="#71717a" />
          </Pressable>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={
              !connected ? 'Disconnected...'
                : busy ? 'Otto is working — your message will queue'
                : 'Message Otto...'
            }
            placeholderTextColor="#71717a"
            multiline
            editable={connected}
            style={{ flex: 1, backgroundColor: '#0d0d0e', borderWidth: 1, borderColor: '#2a2a2e', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, color: '#e4e4e7', fontSize: 14, maxHeight: 120 }}
            onSubmitEditing={onSend}
            blurOnSubmit={false}
          />
          {busy ? (
            <Pressable onPress={onStop} style={{ backgroundColor: 'rgba(239,68,68,0.8)', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 }}>
              <Square size={16} color="white" fill="white" />
            </Pressable>
          ) : (
            <Pressable
              onPress={() => { void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onSend(); }}
              disabled={!connected || (!input.trim() && confirmedAttachments.length === 0) || pendingUploads.length > 0}
              style={{ backgroundColor: '#6366f1', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, opacity: (!connected || (!input.trim() && confirmedAttachments.length === 0)) ? 0.5 : 1 }}
            >
              <Send size={16} color="white" />
            </Pressable>
          )}
        </View>
        {!keyboardVisible && <View style={{ height: insets.bottom }} />}
        </View>
      </KeyboardAvoidingView>
    </>
  );
}
