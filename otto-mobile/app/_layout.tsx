import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colors as t } from '@/lib/theme';

export default function RootLayout() {
  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: t.surface },
          headerTintColor: t.text,
          headerTitleStyle: { fontWeight: '600' },
          contentStyle: { backgroundColor: t.surface },
        }}
      />
    </>
  );
}
