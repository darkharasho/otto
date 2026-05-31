import { View, Text, FlatList, Pressable, Alert } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { Plus } from 'lucide-react-native';
import { useAppStore } from '@/lib/store';
import { useTheme } from '@/lib/theme';
import { MachineCard } from '@/components/MachineCard';
import { OttoMark } from '@/components/OttoMark';

export default function MachineListScreen() {
  const machines = useAppStore((s) => s.machines);
  const removeMachine = useAppStore((s) => s.removeMachine);
  const updateMachine = useAppStore((s) => s.updateMachine);
  const setActiveMachine = useAppStore((s) => s.setActiveMachine);
  const router = useRouter();
  const t = useTheme();

  const handlePress = (id: string) => {
    setActiveMachine(id);
    router.push(`/chat/${id}`);
  };

  const handleDelete = (id: string, label: string) => {
    Alert.alert(
      'Remove machine',
      `Unpair from "${label}"? You can re-pair later by scanning a new QR code.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => removeMachine(id) },
      ],
    );
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 }}>
              <OttoMark size={24} color={t.accent} />
              <Text style={{ color: t.text, fontSize: 17, fontWeight: '600' }}>Otto</Text>
            </View>
          ),
          headerRight: () => (
            <View style={{ paddingLeft: 6 }}>
              <Pressable onPress={() => router.push('/scan')} hitSlop={12}>
                <Plus size={24} color={t.accent} />
              </Pressable>
            </View>
          ),
        }}
      />
      <View style={{ flex: 1, backgroundColor: t.bg, paddingHorizontal: 16, paddingTop: 16 }}>
        {machines.length === 0 ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, marginTop: -72 }}>
            <View style={{ marginBottom: 16, opacity: 0.8 }}>
              <OttoMark size={72} color={t.accent} />
            </View>
            <Text style={{ color: t.text, fontSize: 18, fontWeight: '600', marginBottom: 8 }}>No machines paired</Text>
            <Text style={{ color: t.textMuted, fontSize: 14, textAlign: 'center', marginBottom: 24 }}>
              Tap the + button to scan a QR code from your desktop's Otto settings.
            </Text>
            <Pressable
              onPress={() => router.push('/scan')}
              style={{ backgroundColor: t.accent, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12 }}
            >
              <Text style={{ color: '#ffffff', fontWeight: '500' }}>Add machine</Text>
            </Pressable>
          </View>
        ) : (
          <FlatList
            data={machines}
            keyExtractor={(m) => m.id}
            renderItem={({ item }) => (
              <MachineCard
                machine={item}
                onPress={() => handlePress(item.id)}
                onDelete={() => handleDelete(item.id, item.label)}
                onRename={(name) => updateMachine(item.id, { label: name })}
              />
            )}
            ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
            ListHeaderComponent={
              <Text style={{ color: t.textMuted, fontSize: 13, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 }}>
                Your machines
              </Text>
            }
            contentContainerStyle={{ paddingBottom: 32 }}
          />
        )}
      </View>
    </>
  );
}
