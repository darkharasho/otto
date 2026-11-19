import { useState } from 'react';
import { View, Text, TextInput, Pressable } from 'react-native';
import { KeyRound } from 'lucide-react-native';
import type { SudoPrompt } from '@/lib/transcript';
import { colors, mono } from '@/lib/theme';

interface Props {
  prompt: SudoPrompt;
  /** null cancels. */
  onSubmit(password: string | null): void;
}

/** Otto needs the computer's administrator password to run a sudo command. */
export function SudoCard({ prompt, onSubmit }: Props) {
  const [password, setPassword] = useState('');

  const submit = () => {
    if (!password) return;
    onSubmit(password);
    setPassword('');
  };

  return (
    <View style={{ borderRadius: 12, borderWidth: 1, borderColor: colors.accentBorder, backgroundColor: colors.surface, padding: 12, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <KeyRound size={16} color={colors.accent} />
        <Text style={{ fontWeight: '600', fontSize: 14, color: colors.text }}>Administrator password</Text>
      </View>
      <Text style={{ fontFamily: mono, fontSize: 12, color: colors.textMuted }} numberOfLines={3}>sudo {prompt.command}</Text>
      {prompt.error ? <Text style={{ fontSize: 13, color: colors.danger }}>{prompt.error}</Text> : null}
      <TextInput
        value={password}
        onChangeText={setPassword}
        placeholder="Password"
        placeholderTextColor={colors.textMuted}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={submit}
        style={{ backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, color: colors.text, fontSize: 14 }}
      />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable
          onPress={() => onSubmit(null)}
          style={{ flex: 1, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, paddingVertical: 10, alignItems: 'center' }}
        >
          <Text style={{ color: colors.text, fontSize: 14, fontWeight: '500' }}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={submit}
          disabled={!password}
          style={{ flex: 1, borderRadius: 8, backgroundColor: colors.accent, paddingVertical: 10, alignItems: 'center', opacity: password ? 1 : 0.5 }}
        >
          <Text style={{ color: colors.white, fontSize: 14, fontWeight: '500' }}>Unlock</Text>
        </Pressable>
      </View>
    </View>
  );
}
