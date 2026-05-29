import React, { useEffect, useRef } from 'react';
import { View, Animated, Easing } from 'react-native';

const DOT_SIZE = 5;
const GAP = 4;
const DURATION = 1100;
const STAGGER = 150;

/**
 * Three bouncing dots matching the desktop's otto-typing animation.
 *
 * Keyframes (per dot):
 *   0%, 60%, 100%  → opacity 0.3, translateY(0)
 *   30%            → opacity 1, translateY(-2)
 *
 * Stagger: 0ms, 150ms, 300ms
 */
export function TypingDots() {
  const anims = useRef([
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
  ]).current;

  useEffect(() => {
    const loops = anims.map((anim, i) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(i * STAGGER),
          Animated.timing(anim, {
            toValue: 1,
            duration: DURATION,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          // Reset for next loop iteration
          Animated.timing(anim, {
            toValue: 0,
            duration: 0,
            useNativeDriver: true,
          }),
        ]),
      );
    });
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [anims]);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: GAP, paddingVertical: 6, paddingHorizontal: 2 }}>
      {anims.map((anim, i) => {
        // Map 0→1 progress to the keyframe curve:
        // 0–0.3: opacity 0.3→1, translateY 0→-2
        // 0.3–0.6: opacity 1→0.3, translateY -2→0
        // 0.6–1.0: opacity 0.3, translateY 0
        const opacity = anim.interpolate({
          inputRange: [0, 0.3, 0.6, 1],
          outputRange: [0.3, 1, 0.3, 0.3],
        });
        const translateY = anim.interpolate({
          inputRange: [0, 0.3, 0.6, 1],
          outputRange: [0, -2, 0, 0],
        });
        return (
          <Animated.View
            key={i}
            style={{
              width: DOT_SIZE,
              height: DOT_SIZE,
              borderRadius: DOT_SIZE,
              backgroundColor: '#6366f1',
              opacity,
              transform: [{ translateY }],
            }}
          />
        );
      })}
    </View>
  );
}
