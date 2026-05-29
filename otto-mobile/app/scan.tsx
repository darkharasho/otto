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
      <View className="flex-1 bg-bg items-center justify-center">
        <Text className="text-muted">Checking camera permissions...</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <>
        <Stack.Screen options={{ title: 'Add machine' }} />
        <View className="flex-1 bg-bg items-center justify-center px-8">
          <Text className="text-text text-lg font-semibold mb-2 text-center">Camera access needed</Text>
          <Text className="text-muted text-sm text-center mb-6">
            Otto needs camera access to scan the pairing QR code from your desktop.
          </Text>
          <Pressable onPress={requestPermission} className="bg-accent rounded-xl px-6 py-3 mb-4">
            <Text className="text-white font-medium">Grant access</Text>
          </Pressable>
          <Pressable onPress={() => setShowManual(true)}>
            <Text className="text-accent text-sm">Or paste URL manually</Text>
          </Pressable>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Add machine' }} />
      <View className="flex-1 bg-bg">
        {!showManual ? (
          <View className="flex-1">
            <CameraView
              style={{ flex: 1 }}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={handleBarcode}
            />
            {/* Overlay with cutout hint */}
            <View className="absolute inset-0 items-center justify-center" pointerEvents="none">
              <View className="w-64 h-64 rounded-3xl border-2 border-white/50" />
              <Text className="text-white/70 text-sm mt-4">
                Scan the QR code from Otto desktop settings
              </Text>
            </View>
            {/* Busy indicator */}
            {busy && (
              <View className="absolute inset-0 bg-black/60 items-center justify-center">
                <Text className="text-white text-lg font-semibold">Pairing...</Text>
              </View>
            )}
            {/* Manual fallback button */}
            <View className="absolute bottom-12 left-0 right-0 items-center">
              <Pressable
                onPress={() => setShowManual(true)}
                className="bg-surface/90 rounded-xl px-5 py-2.5"
              >
                <Text className="text-text text-sm">Paste URL instead</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1 px-6 pt-8">
            <Text className="text-text text-lg font-semibold mb-2">Paste pairing URL</Text>
            <Text className="text-muted text-sm mb-4">
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
              className="bg-surface border border-border rounded-xl p-3 text-text text-sm mb-4"
              style={{ minHeight: 80 }}
            />
            <Pressable
              onPress={handleManualSubmit}
              disabled={busy || !manualInput.trim()}
              className="bg-accent rounded-xl py-3 items-center mb-3"
              style={{ opacity: busy || !manualInput.trim() ? 0.5 : 1 }}
            >
              <Text className="text-white font-medium">
                {busy ? 'Pairing...' : 'Pair'}
              </Text>
            </Pressable>
            <Pressable onPress={() => setShowManual(false)} className="items-center">
              <Text className="text-accent text-sm">Back to camera</Text>
            </Pressable>
          </KeyboardAvoidingView>
        )}
      </View>
    </>
  );
}
