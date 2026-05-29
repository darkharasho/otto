import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { SvgXml } from 'react-native-svg';

interface Props {
  url: string;
  size: number;
  color: string;
}

// Cache fetched SVG strings so repeated emoji don't re-fetch.
const svgCache = new Map<string, string>();

/**
 * Loads a monochrome SVG from the Iconify CDN (Fluent UI Emoji High Contrast)
 * and tints it to the given color by rewriting stroke/fill attributes.
 */
export function FluentEmoji({ url, size, color }: Props) {
  const [xml, setXml] = useState<string | null>(svgCache.get(url) ?? null);

  useEffect(() => {
    if (svgCache.has(url)) {
      setXml(svgCache.get(url)!);
      return;
    }
    let cancelled = false;
    fetch(url)
      .then((r) => r.text())
      .then((svg) => {
        if (cancelled) return;
        // Recolor: replace black fills/strokes with our accent color.
        // Fluent High Contrast icons use currentColor or black (#000/#212121).
        const tinted = svg
          .replace(/fill="[^"]*"/g, `fill="${color}"`)
          .replace(/stroke="[^"]*"/g, `stroke="${color}"`);
        svgCache.set(url, tinted);
        setXml(tinted);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [url, color]);

  if (!xml) {
    // Placeholder while loading — same size so layout doesn't shift.
    return <View style={{ width: size, height: size }} />;
  }

  return <SvgXml xml={xml} width={size} height={size} />;
}
