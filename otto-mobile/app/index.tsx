import { View, Text, FlatList, Pressable, Alert, Image } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { Plus } from 'lucide-react-native';
import { useAppStore } from '@/lib/store';
import { MachineCard } from '@/components/MachineCard';

const logo = require('@/assets/icon.png');

export default function MachineListScreen() {
  const machines = useAppStore((s) => s.machines);
  const removeMachine = useAppStore((s) => s.removeMachine);
  const updateMachine = useAppStore((s) => s.updateMachine);
  const setActiveMachine = useAppStore((s) => s.setActiveMachine);
  const router = useRouter();

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
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Image source={logo} style={{ width: 28, height: 28 }} />
              <Text style={{ color: '#e4e4e7', fontSize: 17, fontWeight: '600' }}>Otto</Text>
            </View>
          ),
          headerRight: () => (
            <View style={{ paddingLeft: 6 }}>
              <Pressable onPress={() => router.push('/scan')} hitSlop={12}>
                <Plus size={24} color="#6366f1" />
              </Pressable>
            </View>
          ),
        }}
      />
      <View style={{ flex: 1, backgroundColor: '#1a1a1c', paddingHorizontal: 16, paddingTop: 16 }}>
        {machines.length === 0 ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, marginTop: -72 }}>
            <Image source={logo} style={{ width: 72, height: 72, marginBottom: 16, opacity: 0.6 }} />
            <Text style={{ color: '#e4e4e7', fontSize: 18, fontWeight: '600', marginBottom: 8 }}>No machines paired</Text>
            <Text style={{ color: '#71717a', fontSize: 14, textAlign: 'center', marginBottom: 24 }}>
              Tap the + button to scan a QR code from your desktop's Otto settings.
            </Text>
            <Pressable
              onPress={() => router.push('/scan')}
              style={{ backgroundColor: '#6366f1', borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12 }}
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
            contentContainerStyle={{ paddingBottom: 32 }}
          />
        )}
      </View>
    </>
  );
}
