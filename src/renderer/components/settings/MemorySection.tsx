import { useEffect, useState, useCallback } from 'react';
import { ipc } from '../../ipc';
import type { MemoryArtifactView, MemoryFactView } from '@shared/ipc-contract';
import { SubsectionPage } from './SubsectionPage';

export type MemoryKind = 'fact' | 'playbook' | 'anti_pattern' | 'heuristic';

const KIND_LABELS: Record<MemoryKind, string> = {
  fact: 'Facts',
  playbook: 'Playbooks',
  anti_pattern: 'Anti-patterns',
  heuristic: 'Heuristics',
};

export function MemorySection({ kind }: { kind: MemoryKind }) {
  const [query, setQuery] = useState('');
  const [artifacts, setArtifacts] = useState<MemoryArtifactView[]>([]);
  const [facts, setFacts] = useState<MemoryFactView[]>([]);
  const [editing, setEditing] = useState<MemoryArtifactView | null>(null);

  const load = useCallback(async () => {
    const out = await ipc.invoke('memory.list', { kind, query: query.trim() || undefined });
    setArtifacts(out.artifacts);
    setFacts(out.facts);
  }, [kind, query]);

  useEffect(() => {
    setQuery('');
  }, [kind]);

  useEffect(() => {
    void load();
  }, [load]);

  async function archive(id: string) {
    await ipc.invoke('memory.update', { id, patch: { archived: true } });
    await load();
  }

  async function remove(id: string) {
    if (!confirm('Delete this entry permanently?')) return;
    await ipc.invoke('memory.delete', { id });
    await load();
  }

  async function saveEdit() {
    if (!editing) return;
    await ipc.invoke('memory.update', {
      id: editing.id,
      patch: { title: editing.title, body: editing.body, tags: editing.tags },
    });
    setEditing(null);
    await load();
  }

  return (
    <SubsectionPage title={KIND_LABELS[kind]}>
      <div className="space-y-3">
        <input
        type="text"
        placeholder="Search…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full px-2 py-1 text-sm bg-bg/40 border border-border rounded"
      />

      {kind === 'fact' ? (
        <ul className="space-y-1 text-xs text-text">
          {facts.length === 0 ? (
            <li className="text-muted">No facts yet.</li>
          ) : (
            facts.map((f) => (
              <li key={f.id} className="flex items-start gap-2">
                {f.pinned && (
                  <span className="px-1 rounded bg-accent/20 text-accent text-[10px] uppercase">pinned</span>
                )}
                <span className="flex-1">{f.body}</span>
                <span className="text-muted text-[10px] tabular-nums">{f.useCount}×</span>
              </li>
            ))
          )}
        </ul>
      ) : (
        <ul className="space-y-2">
          {artifacts.length === 0 ? (
            <li className="text-xs text-muted">Nothing here yet.</li>
          ) : (
            artifacts.map((a) => (
              <li key={a.id} className="rounded border border-border p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{a.title}</div>
                    <div className="text-[11px] text-muted flex flex-wrap gap-1 mt-1">
                      {a.tags.map((t) => (
                        <span key={t} className="px-1 rounded bg-bg/60">{t}</span>
                      ))}
                      <span>used {a.useCount}×</span>
                    </div>
                  </div>
                  <div className="flex gap-2 text-xs">
                    <button type="button" className="text-accent hover:underline" onClick={() => setEditing(a)}>Edit</button>
                    <button type="button" className="text-muted hover:text-text" onClick={() => archive(a.id)}>Archive</button>
                    <button type="button" className="text-danger hover:underline" onClick={() => remove(a.id)}>Delete</button>
                  </div>
                </div>
              </li>
            ))
          )}
        </ul>
      )}

      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-surface border border-border rounded-lg p-4 w-[640px] max-h-[80vh] flex flex-col gap-2">
            <input
              type="text"
              value={editing.title}
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
              className="px-2 py-1 text-sm bg-bg/40 border border-border rounded"
            />
            <textarea
              value={editing.body}
              onChange={(e) => setEditing({ ...editing, body: e.target.value })}
              className="flex-1 min-h-[240px] px-2 py-1 text-xs font-mono bg-bg/40 border border-border rounded"
            />
            <input
              type="text"
              value={editing.tags.join(', ')}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                })
              }
              placeholder="comma-separated tags"
              className="px-2 py-1 text-xs bg-bg/40 border border-border rounded"
            />
            <div className="flex justify-end gap-2 text-xs">
              <button type="button" className="text-muted hover:text-text" onClick={() => setEditing(null)}>Cancel</button>
              <button type="button" className="text-accent hover:underline" onClick={saveEdit}>Save</button>
            </div>
          </div>
        </div>
      )}

      </div>
    </SubsectionPage>
  );
}
