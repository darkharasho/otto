import { useState, useRef } from 'react';
import { View, Text, TextInput, Pressable, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Device from 'expo-device';
import * as Haptics from 'expo-haptics';
import { pair, parsePairingUrl } from '@/lib/wire';
import { useAppStore } from '@/lib/store';

function deviceLabel(): string {
  return Device.modelName ?? (Platform.OS === 'ios' ? 'iPhone' : 'Android');
}

export default function ScanScreen() {
  const router = useRouter();
  const addMachine = useAppStore((s) => s.addMachine);
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [manualInput, setManualInput] = useState('');
  const [showManual, setShowManual] = useState(false);
  const scannedRef = useRef(false);

  const doPair = async (baseUrl: string, code: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await pair(baseUrl, code, deviceLabel());
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      addMachine({
        id: result.deviceId,
        label: result.hostLabel ?? baseUrl,
        baseUrl,
        token: result.token,
        lastSeen: Date.now(),
        platform: result.platform,
      });
      router.back();
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Pairing failed', (err as Error).message);
      scannedRef.current = false;
    } finally {
      setBusy(false);
    }
  };

  const handleBarcode = (result: { data: string }) => {
    if (scannedRef.current || busy) return;
    const parsed = parsePairingUrl(result.data);
    if (!parsed) return;
    scannedRef.current = true;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    void doPair(parsed.baseUrl, parsed.code);
  };

  const handleManualSubmit = () => {
    const parsed = parsePairingUrl(manualInput);
    if (!parsed) {
      Alert.alert('Invalid input', 'Paste the full pairing URL from Otto desktop settings.');
      return;
    }
    void doPair(parsed.baseUrl, parsed.code);
  };

  if (!permission) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0d0d0e', alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#71717a' }}>Checking camera permissions...</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <>
        <Stack.Screen options={{ title: 'Add machine' }} />
        <View style={{ flex: 1, backgroundColor: '#0d0d0e', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
          <Text style={{ color: '#e4e4e7', fontSize: 18, fontWeight: '600', marginBottom: 8, textAlign: 'center' }}>Camera access needed</Text>
          <Text style={{ color: '#71717a', fontSize: 14, textAlign: 'center', marginBottom: 24 }}>
            Otto needs camera access to scan the pairing QR code from your desktop.
          </Text>
          <Pressable onPress={requestPermission} style={{ backgroundColor: '#6366f1', borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, marginBottom: 16 }}>
            <Text style={{ color: '#ffffff', fontWeight: '500' }}>Grant access</Text>
          </Pressable>
          <Pressable onPress={() => setShowManual(true)}>
            <Text style={{ color: '#6366f1', fontSize: 14 }}>Or paste URL manually</Text>
          </Pressable>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Add machine' }} />
      <View style={{ flex: 1, backgroundColor: '#0d0d0e' }}>
        {!showManual ? (
          <View style={{ flex: 1 }}>
            <CameraView
              style={{ flex: 1 }}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={handleBarcode}
            />
            {/* Overlay with cutout hint */}
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }} pointerEvents="none">
              <View style={{ width: 256, height: 256, borderRadius: 24, borderWidth: 2, borderColor: 'rgba(255,255,255,0.5)' }} />
              <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14, marginTop: 16 }}>
                Scan the QR code from Otto desktop settings
              </Text>
            </View>
            {/* Busy indicator */}
            {busy && (
              <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: '#ffffff', fontSize: 18, fontWeight: '600' }}>Pairing...</Text>
              </View>
            )}
            {/* Manual fallback button */}
            <View style={{ position: 'absolute', bottom: 48, left: 0, right: 0, alignItems: 'center' }}>
              <Pressable
                onPress={() => setShowManual(true)}
                style={{ backgroundColor: 'rgba(26,26,28,0.9)', borderRadius: 12, paddingHorizontal: 20, paddingVertical: 10 }}
              >
                <Text style={{ color: '#e4e4e7', fontSize: 14 }}>Paste URL instead</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, paddingHorizontal: 24, paddingTop: 32 }}>
            <Text style={{ color: '#e4e4e7', fontSize: 18, fontWeight: '600', marginBottom: 8 }}>Paste pairing URL</Text>
            <Text style={{ color: '#71717a', fontSize: 14, marginBottom: 16 }}>
              On your desktop, open Otto Settings &gt; Mobile remote and copy the pairing URL.
            </Text>
            <TextInput
              value={manualInput}
              onChangeText={setManualInput}
              placeholder="http://...?code=XYZ"
              placeholderTextColor="#71717a"
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              style={{ backgroundColor: '#1a1a1c', borderWidth: 1, borderColor: '#2a2a2e', borderRadius: 12, padding: 12, color: '#e4e4e7', fontSize: 14, marginBottom: 16, minHeight: 80 }}
            />
            <Pressable
              onPress={handleManualSubmit}
              disabled={busy || !manualInput.trim()}
              style={{ backgroundColor: '#6366f1', borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginBottom: 12, opacity: busy || !manualInput.trim() ? 0.5 : 1 }}
            >
              <Text style={{ color: '#ffffff', fontWeight: '500' }}>
                {busy ? 'Pairing...' : 'Pair'}
              </Text>
            </Pressable>
            <Pressable onPress={() => setShowManual(false)} style={{ alignItems: 'center' }}>
              <Text style={{ color: '#6366f1', fontSize: 14 }}>Back to camera</Text>
            </Pressable>
          </KeyboardAvoidingView>
        )}
      </View>
    </>
  );
}
