import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  View, Text, TextInput, Pressable, FlatList, AppState, Alert,
  KeyboardAvoidingView, Platform, Image, Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, Stack } from 'expo-router';
import { Menu, Send, Square, Paperclip } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { useAppStore } from '@/lib/store';
import { MachineConnection } from '@/lib/connection';
import { authHeaders, getHistory, loadMessages, userUploadUrl, type ImageRef } from '@/lib/wire';
import { initialTranscript, isBusy, transcriptReducer, type TranscriptItem } from '@/lib/transcript';
import { colors } from '@/lib/theme';
import { ApprovalCard } from '@/components/ApprovalCard';
import { ChatMarkdown } from '@/components/ChatMarkdown';
import { OttoMark } from '@/components/OttoMark';
import { OutcomeCard } from '@/components/OutcomeCard';
import { ReasoningBlock } from '@/components/ReasoningBlock';
import { SessionDrawer } from '@/components/SessionDrawer';
import { SudoCard } from '@/components/SudoCard';
import { ToolCard } from '@/components/ToolCard';
import { TypingDots } from '@/components/TypingDots';

/** Longest side of a photo sent to the desktop; iPhone originals are 4000+ px. */
const MAX_PHOTO_SIDE = 2048;
const REPLY_TIMEOUT_MS = 30_000;

function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function ChatScreen() {
  const { machineId } = useLocalSearchParams<{ machineId: string }>();
  const insets = useSafeAreaInsets();
  const machine = useAppStore((s) => s.getMachine(machineId));
  const updateMachine = useAppStore((s) => s.updateMachine);

  const [t, dispatch] = useReducer(transcriptReducer, initialTranscript);
  const tRef = useRef(t);
  tRef.current = t;
  const busy = isBusy(t);

  const [connected, setConnected] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  /** Bumped on every successful auth, so a failed transcript load retries. */
  const [authEpoch, setAuthEpoch] = useState(0);
  const [input, setInput] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [pendingUploads, setPendingUploads] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<ImageRef[]>([]);

  const connRef = useRef<MachineConnection | null>(null);
  const listRef = useRef<FlatList<TranscriptItem>>(null);

  const scrollToEnd = useCallback((animated = true) => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated }), 100);
  }, []);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => {
      setKeyboardVisible(true);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 300);
    });
    const hide = Keyboard.addListener('keyboardWillHide', () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  // --- Connection ---
  useEffect(() => {
    if (!machine) return;
    const { baseUrl, token } = machine;
    const conn = new MachineConnection(baseUrl, token, {
      onAuthOk: (frame) => {
        setConnected(true);
        setUnreachable(false);
        setAuthEpoch((n) => n + 1);
        updateMachine(machine.id, { lastSeen: Date.now() });
        const cur = tRef.current;
        if (!cur.sessionId) {
          if (frame.activeSessionId) dispatch({ type: 'open', sessionId: frame.activeSessionId });
          return;
        }
        if (cur.needsLoad) return; // the load effect retries on the new epoch
        // Catch up on what we missed while disconnected.
        const sid = cur.sessionId;
        getHistory(baseUrl, token, sid, cur.lastSeq)
          .then((h) => {
            if (tRef.current.sessionId !== sid) return;
            dispatch(h.truncated ? { type: 'open', sessionId: sid } : { type: 'replay', entries: h.events });
          })
          .catch(() => { /* the next reconnect tries again */ });
      },
      onFrame: (frame) => {
        if (frame.type === 'attach_ok') {
          setPendingUploads((p) => p.filter((id) => id !== frame.clientCorrelationId));
          setAttachments((a) => [...a, frame.ref]);
          return;
        }
        if (frame.type === 'attach_err') {
          setPendingUploads((p) => p.filter((id) => id !== frame.clientCorrelationId));
          dispatch({ type: 'error', message: `Couldn't attach the photo: ${frame.message}` });
          return;
        }
        dispatch({ type: 'frame', frame });
      },
      onDisconnected: () => setConnected(false),
      onUnreachable: () => setUnreachable(true),
      onBaseUrlChanged: (newBaseUrl) => updateMachine(machine.id, { baseUrl: newBaseUrl }),
    });
    connRef.current = conn;
    conn.connect();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') conn.resume();
    });
    return () => {
      sub.remove();
      conn.disconnect();
      connRef.current = null;
    };
  // Reconnect only when the address or credentials change, not on lastSeen updates.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine?.id, machine?.baseUrl, machine?.token]);

  // --- Load a session's transcript (on open, on following the desktop, or after a gap) ---
  useEffect(() => {
    if (!machine || !t.needsLoad || !t.sessionId) return;
    const sid = t.sessionId;
    let cancelled = false;
    (async () => {
      try {
        const { messages, seq } = await loadMessages(machine.baseUrl, machine.token, sid);
        const { events } = await getHistory(machine.baseUrl, machine.token, sid, 0);
        if (cancelled) return;
        dispatch({ type: 'loaded', sessionId: sid, messages, seq, entries: events });
        scrollToEnd(false);
        // Live events that landed while this was loading were replaced by the
        // load; fetch anything newer than what it covered.
        const covered = events.reduce((m, e) => Math.max(m, e.seq), 0);
        const more = await getHistory(machine.baseUrl, machine.token, sid, covered);
        if (!cancelled && more.events.length > 0) dispatch({ type: 'replay', entries: more.events });
      } catch {
        // Retried when the connection next authenticates (authEpoch).
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.needsLoad, t.sessionId, authEpoch]);

  // --- Nothing came back after a send ---
  useEffect(() => {
    if (!t.awaitingReply) return;
    const timer = setTimeout(() => dispatch({ type: 'reply-timeout' }), REPLY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [t.awaitingReply]);

  useEffect(() => {
    scrollToEnd();
  }, [t.items.length, t.approvals.length, t.sudos.length, scrollToEnd]);

  if (!machine) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: colors.danger }}>Machine not found</Text>
      </View>
    );
  }

  const send = (frame: Parameters<MachineConnection['send']>[0]): boolean => {
    const ok = connRef.current?.send(frame) ?? false;
    if (!ok) dispatch({ type: 'error', message: "Not connected to Otto. Try again in a moment." });
    return ok;
  };

  const onSend = () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || pendingUploads.length > 0) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const ok = send({
      v: 1,
      type: 'prompt',
      sessionId: t.sessionId ?? '',
      text,
      attachmentIds: attachments.length > 0 ? attachments.map((r) => r.id) : undefined,
    });
    if (!ok) return;
    setInput('');
    setAttachments([]);
    dispatch({ type: 'sent' });
  };

  const pickImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    const asset = result.canceled ? undefined : result.assets?.[0];
    if (!asset) return;
    const correlationId = newId();
    setPendingUploads((p) => [...p, correlationId]);
    try {
      // Shrink and re-encode as JPEG: originals are several MB of base64 over
      // the socket, and HEIC isn't something the desktop's model can read.
      const ctx = ImageManipulator.manipulate(asset.uri);
      if (Math.max(asset.width, asset.height) > MAX_PHOTO_SIDE) {
        ctx.resize(asset.width >= asset.height ? { width: MAX_PHOTO_SIDE } : { height: MAX_PHOTO_SIDE });
      }
      const image = await ctx.renderAsync();
      const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true });
      if (!saved.base64) throw new Error('could not read the photo');
      const ok = send({
        v: 1,
        type: 'attach',
        sessionId: t.sessionId ?? '',
        mimeType: 'image/jpeg',
        bytesBase64: saved.base64,
        clientCorrelationId: correlationId,
      });
      if (!ok) setPendingUploads((p) => p.filter((id) => id !== correlationId));
    } catch (err) {
      setPendingUploads((p) => p.filter((id) => id !== correlationId));
      dispatch({ type: 'error', message: `Couldn't attach the photo: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const renameMachine = () => {
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
  };

  const renderItem = ({ item: it, index }: { item: TranscriptItem; index: number }) => {
    const prev = index > 0 ? t.items[index - 1] : null;
    if (it.kind === 'user') {
      return (
        <View style={{ alignItems: 'flex-end', paddingHorizontal: 12, marginBottom: 12 }}>
          <View style={{ borderRadius: 16, borderBottomRightRadius: 6, backgroundColor: 'rgba(99,102,241,0.2)', borderWidth: 1, borderColor: colors.accentBorder, paddingHorizontal: 16, paddingVertical: 8, maxWidth: '80%' }}>
            {it.images.length > 0 && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: it.text ? 4 : 0 }}>
                {it.images.map((ref) => (
                  <Image
                    key={ref.id}
                    source={{ uri: userUploadUrl(machine.baseUrl, ref), headers: authHeaders(machine.token) }}
                    style={{ width: 80, height: 80, borderRadius: 8 }}
                    resizeMode="cover"
                  />
                ))}
              </View>
            )}
            {it.text ? <ChatMarkdown baseUrl={machine.baseUrl} token={machine.token}>{it.text}</ChatMarkdown> : null}
          </View>
        </View>
      );
    }
    if (it.kind === 'notice') {
      return (
        <View style={{ paddingHorizontal: 24, marginBottom: 12 }}>
          <Text style={{ color: colors.textMuted, fontSize: 12, textAlign: 'center' }}>{it.text}</Text>
        </View>
      );
    }
    // Otto's side: label the first item after a user message.
    const label = !prev || prev.kind === 'user' ? (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <OttoMark size={14} color={colors.accent} />
        <Text style={{ color: colors.textDim, fontSize: 12, fontWeight: '500' }}>Otto</Text>
      </View>
    ) : null;
    let body: React.ReactNode;
    switch (it.kind) {
      case 'text':
        if (!it.text) return null; // the typing indicator covers an empty bubble
        body = <ChatMarkdown baseUrl={machine.baseUrl} token={machine.token}>{it.text}</ChatMarkdown>;
        break;
      case 'reasoning':
        body = <ReasoningBlock text={it.text} done={it.done} />;
        break;
      case 'tool':
        body = (
          <ToolCard
            name={it.name} input={it.input} status={it.status} result={it.result} isError={it.isError}
            output={it.output} snapshot={it.snapshot} takeaway={it.takeaway} why={it.why} deniedReason={it.deniedReason}
          />
        );
        break;
      case 'outcome':
        body = <OutcomeCard block={it.block} />;
        break;
    }
    return (
      <View style={{ paddingHorizontal: 12, marginBottom: it.kind === 'tool' ? 8 : 12 }}>
        {label}
        {body}
      </View>
    );
  };

  const canSend = connected && (input.trim().length > 0 || attachments.length > 0) && pendingUploads.length === 0;

  return (
    <>
      <Stack.Screen
        options={{
          header: () => (
            <View style={{ backgroundColor: colors.surface, paddingTop: insets.top + 10, paddingBottom: 12, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center' }}>
              <Pressable onPress={() => setDrawerOpen(true)} hitSlop={12} accessibilityLabel="Conversations">
                <Menu size={22} color={colors.text} />
              </Pressable>
              <Pressable onPress={renameMachine} style={{ flex: 1 }}>
                <Text style={{ textAlign: 'center', color: colors.text, fontSize: 17, fontWeight: '600' }}>{machine.label}</Text>
              </Pressable>
              <View
                accessibilityLabel={connected ? 'Connected' : 'Disconnected'}
                style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: connected ? colors.success : '#f97316' }}
              />
            </View>
          ),
        }}
      />

      <SessionDrawer
        open={drawerOpen}
        baseUrl={machine.baseUrl}
        token={machine.token}
        currentSessionId={t.sessionId}
        onClose={() => setDrawerOpen(false)}
        onNewSession={() => {
          send({ v: 1, type: 'new_session' });
          setDrawerOpen(false);
        }}
        onPickSession={(sid) => {
          send({ v: 1, type: 'switch_session', sessionId: sid });
          setDrawerOpen(false);
        }}
      />

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: colors.bg }}>
        {unreachable && !connected && (
          <View style={{ paddingHorizontal: 12, paddingVertical: 8, backgroundColor: 'rgba(245,158,11,0.15)', borderBottomWidth: 1, borderBottomColor: 'rgba(245,158,11,0.3)' }}>
            <Text style={{ color: '#fde68a', fontSize: 12, fontWeight: '600' }}>
              Can't reach Otto at {machine.baseUrl.replace(/^https?:\/\//, '')}
            </Text>
            <Text style={{ color: 'rgba(253,230,138,0.8)', fontSize: 12, marginTop: 2 }}>
              Check that Otto is running and that both devices are on the same network or Tailscale.
            </Text>
          </View>
        )}

        {(t.approvals.length > 0 || t.sudos.length > 0) && (
          <View style={{ paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 8 }}>
            {t.sudos.map((p) => (
              <SudoCard
                key={p.promptId}
                prompt={p}
                onSubmit={(password) => {
                  if (send({ v: 1, type: 'sudo', promptId: p.promptId, password })) dispatch({ type: 'sudo-answered', promptId: p.promptId });
                }}
              />
            ))}
            {t.approvals.map((a) => (
              <ApprovalCard
                key={a.decisionId}
                approval={a}
                onResolve={(decision) => {
                  if (send({ v: 1, type: 'approval', decisionId: a.decisionId, decision })) dispatch({ type: 'approval-answered', decisionId: a.decisionId });
                }}
              />
            ))}
          </View>
        )}

        <FlatList
          ref={listRef}
          data={t.items}
          keyExtractor={(it) => it.id}
          renderItem={renderItem}
          contentContainerStyle={{ paddingTop: 16, paddingBottom: 8 }}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', paddingTop: 64 }}>
              <Text style={{ color: colors.textMuted, fontSize: 14 }}>
                {!connected ? 'Connecting...' : t.needsLoad ? 'Loading...' : 'Connected. Send a prompt to begin.'}
              </Text>
            </View>
          }
          ListFooterComponent={busy ? <View style={{ paddingHorizontal: 12, paddingVertical: 4 }}><TypingDots /></View> : null}
        />

        {t.queueDepth > 0 && (
          <View style={{ paddingHorizontal: 12, paddingVertical: 4, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: 'rgba(26,26,28,0.6)' }}>
            <Text style={{ color: colors.textMuted, fontSize: 11 }}>{t.queueDepth} queued</Text>
          </View>
        )}

        {t.error && (
          <View style={{ paddingHorizontal: 12, paddingVertical: 8, backgroundColor: colors.dangerBg, borderTopWidth: 1, borderTopColor: colors.dangerBorder, flexDirection: 'row', alignItems: 'center' }}>
            <Text style={{ color: colors.danger, fontSize: 12, flex: 1 }}>{t.error}</Text>
            <Pressable onPress={() => dispatch({ type: 'dismiss-error' })} hitSlop={8}>
              <Text style={{ color: colors.textMuted, fontSize: 12, marginLeft: 8 }}>Dismiss</Text>
            </Pressable>
          </View>
        )}

        {(pendingUploads.length > 0 || attachments.length > 0) && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface }}>
            {attachments.map((a) => (
              <Pressable key={a.id} onPress={() => setAttachments((s) => s.filter((x) => x.id !== a.id))} accessibilityLabel="Remove photo">
                <Image source={{ uri: userUploadUrl(machine.baseUrl, a), headers: authHeaders(machine.token) }} style={{ width: 44, height: 44, borderRadius: 6 }} />
              </Pressable>
            ))}
            {pendingUploads.map((id) => (
              <View key={id} style={{ width: 44, height: 44, borderRadius: 6, backgroundColor: colors.well, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: colors.textMuted, fontSize: 10 }}>...</Text>
              </View>
            ))}
          </View>
        )}

        <View style={{ backgroundColor: colors.surface }}>
          <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingHorizontal: 8, paddingVertical: 8, flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
            <Pressable onPress={pickImage} disabled={!connected} style={{ padding: 8, opacity: connected ? 1 : 0.5 }} accessibilityLabel="Attach a photo">
              <Paperclip size={18} color={colors.textMuted} />
            </Pressable>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder={!connected ? 'Disconnected...' : busy ? 'Add details and Otto will fold them in' : 'Message Otto...'}
              placeholderTextColor={colors.textMuted}
              multiline
              editable={connected}
              style={{ flex: 1, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, color: colors.text, fontSize: 14, maxHeight: 120 }}
            />
            {busy && !canSend ? (
              <Pressable
                onPress={() => send({ v: 1, type: 'interrupt', sessionId: t.sessionId ?? undefined })}
                accessibilityLabel="Stop"
                style={{ backgroundColor: 'rgba(239,68,68,0.8)', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 }}
              >
                <Square size={16} color={colors.white} fill={colors.white} />
              </Pressable>
            ) : (
              <Pressable
                onPress={onSend}
                disabled={!canSend}
                accessibilityLabel="Send"
                style={{ backgroundColor: colors.accent, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, opacity: canSend ? 1 : 0.5 }}
              >
                <Send size={16} color={colors.white} />
              </Pressable>
            )}
          </View>
          {!keyboardVisible && <View style={{ height: insets.bottom }} />}
        </View>
      </KeyboardAvoidingView>
    </>
  );
}
