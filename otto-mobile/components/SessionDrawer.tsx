import { useEffect, useState, useRef } from 'react';
import { View, Text, Pressable, ScrollView, Animated, Dimensions } from 'react-native';
import { listSessions, type RemoteSessionSummary } from '@/lib/wire';

const DRAWER_WIDTH = 288; // w-72

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  try { return new Date(ms).toLocaleDateString(); } catch { return ''; }
}

interface Props {
  open: boolean;
  baseUrl: string;
  token: string;
  currentSessionId: string | null;
  onClose(): void;
  onNewSession(): void;
  onPickSession(sessionId: string): void;
}

export function SessionDrawer({ open, baseUrl, token, currentSessionId, onClose, onNewSession, onPickSession }: Props) {
  const [sessions, setSessions] = useState<RemoteSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(false);
  const slideAnim = useRef(new Animated.Value(-DRAWER_WIDTH)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (open) {
      setVisible(true);
      Animated.parallel([
        Animated.timing(slideAnim, { toValue: 0, duration: 250, useNativeDriver: true }),
        Animated.timing(fadeAnim, { toValue: 1, duration: 250, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, { toValue: -DRAWER_WIDTH, duration: 200, useNativeDriver: true }),
        Animated.timing(fadeAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start(() => setVisible(false));
    }
  }, [open, slideAnim, fadeAnim]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    listSessions(baseUrl, token, 50)
      .then((r) => setSessions(r.sessions))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open, baseUrl, token]);

  if (!visible) return null;

  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 50 }}>
      {/* Backdrop */}
      <Animated.View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)', opacity: fadeAnim }}>
        <Pressable onPress={onClose} style={{ flex: 1 }} />
      </Animated.View>
      {/* Drawer */}
      <Animated.View style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: DRAWER_WIDTH, backgroundColor: '#1a1a1c', borderRightWidth: 1, borderRightColor: '#2a2a2e', transform: [{ translateX: slideAnim }] }}>
        <View style={{ paddingTop: 56, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#2a2a2e', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: '#e4e4e7' }}>Sessions</Text>
          <Pressable onPress={onClose} hitSlop={8}>
            <Text style={{ fontSize: 12, color: '#71717a' }}>Close</Text>
          </Pressable>
        </View>
        <View style={{ padding: 12, borderBottomWidth: 1, borderBottomColor: '#2a2a2e' }}>
          <Pressable
            onPress={onNewSession}
            style={{ borderRadius: 8, backgroundColor: '#6366f1', paddingVertical: 10, alignItems: 'center' }}
          >
            <Text style={{ color: 'white', fontSize: 14, fontWeight: '500' }}>+ New chat</Text>
          </Pressable>
        </View>
        <ScrollView style={{ flex: 1 }}>
          {loading && <Text style={{ paddingHorizontal: 16, paddingVertical: 12, fontSize: 12, color: '#71717a' }}>Loading...</Text>}
          {!loading && sessions.length === 0 && (
            <Text style={{ paddingHorizontal: 16, paddingVertical: 12, fontSize: 12, color: '#71717a' }}>No sessions yet.</Text>
          )}
          {sessions.map((s) => {
            const isCurrent = s.id === currentSessionId;
            return (
              <Pressable
                key={s.id}
                onPress={() => onPickSession(s.id)}
                style={{ paddingHorizontal: 16, paddingVertical: 10, backgroundColor: isCurrent ? 'rgba(13,13,14,0.4)' : 'transparent' }}
              >
                <Text style={{ fontSize: 14, color: '#e4e4e7' }} numberOfLines={1}>
                  {s.title?.trim() || 'Untitled'}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                  <Text style={{ fontSize: 11, color: '#71717a' }}>
                    {relativeTime(s.lastActive)}
                  </Text>
                  {isCurrent && (
                    <Text style={{ fontSize: 11, color: '#6366f1', marginLeft: 8 }}>current</Text>
                  )}
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
      </Animated.View>
    </View>
  );
}
