import { useState } from 'react';
import { View, Text, Image, Pressable, Modal, Dimensions } from 'react-native';
import { screenshotUrl, authHeaders } from '@/lib/wire';

interface Props {
  shotId: string;
  signedUrl: string;
  baseUrl: string;
  token: string;
}

export function Screenshot({ shotId, signedUrl, baseUrl, token }: Props) {
  const [open, setOpen] = useState(false);
  const uri = screenshotUrl(baseUrl, token, signedUrl);
  const headers = authHeaders(token);
  const { width: screenWidth } = Dimensions.get('window');

  return (
    <>
      <Pressable onPress={() => setOpen(true)}>
        <Image
          source={{ uri, headers }}
          style={{ width: 200, height: 120, borderRadius: 8 }}
          resizeMode="cover"
          accessibilityLabel={`screenshot ${shotId}`}
        />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          onPress={() => setOpen(false)}
          className="flex-1 bg-black/90 items-center justify-center p-4"
        >
          <Image
            source={{ uri, headers }}
            style={{ width: screenWidth - 32, height: (screenWidth - 32) * 0.6 }}
            resizeMode="contain"
          />
        </Pressable>
      </Modal>
    </>
  );
}
