// src/renderer-shared/tool-cards/useShiki.ts
import { useEffect, useState } from 'react';
import type { HighlighterGeneric } from 'shiki';

type AnyHighlighter = HighlighterGeneric<string, string>;

let promise: Promise<AnyHighlighter> | undefined;

function load(): Promise<AnyHighlighter> {
  if (promise) return promise;
  promise = import('shiki').then(({ createHighlighter }) =>
    createHighlighter({
      themes: ['github-dark-dimmed'],
      langs: ['ts', 'tsx', 'js', 'jsx', 'python', 'json', 'bash', 'markdown', 'html', 'css', 'go', 'rust'],
    }),
  ) as Promise<AnyHighlighter>;
  return promise;
}

export function useHighlighted(code: string, lang?: string): string {
  const [html, setHtml] = useState<string>('');
  useEffect(() => {
    let cancelled = false;
    load().then(h => {
      if (cancelled) return;
      const loaded = h.getLoadedLanguages();
      // 'text' is shiki's built-in no-highlight identifier; safe even though not in getLoadedLanguages()
      const useLang = lang && (loaded as string[]).includes(lang) ? lang : 'text';
      setHtml(h.codeToHtml(code, { lang: useLang, theme: 'github-dark-dimmed' }));
    }).catch(() => setHtml(''));
    return () => { cancelled = true; };
  }, [code, lang]);
  return html;
}
