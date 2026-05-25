import type { IconName } from '../shared/tool-presenters';
import {
  Camera, Terminal, FileEdit, FileText, Search, Globe,
  MousePointer, Keyboard, GitBranch, Database, Image, Brain, Plug, Wrench,
} from 'lucide-react';

const MAP: Record<IconName, React.ComponentType<{ className?: string }>> = {
  camera: Camera, terminal: Terminal, edit: FileEdit, file: FileText,
  search: Search, globe: Globe, mouse: MousePointer, keyboard: Keyboard,
  github: GitBranch, database: Database, image: Image, brain: Brain, plug: Plug, tool: Wrench,
};

export function ToolIcon({ name, className }: { name: IconName; className?: string }) {
  const Cmp = MAP[name] ?? Wrench;
  return <Cmp className={className ?? 'w-3 h-3'} />;
}
