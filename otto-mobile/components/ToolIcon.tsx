import type { IconName } from '@/lib/tool-presenters';
import {
  Camera, Terminal, FileEdit, FileText, Search, Globe,
  MousePointer, Keyboard, GitBranch, Database, Image, Brain, Plug, Wrench,
} from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';

const MAP: Record<IconName, LucideIcon> = {
  camera: Camera, terminal: Terminal, edit: FileEdit, file: FileText,
  search: Search, globe: Globe, mouse: MousePointer, keyboard: Keyboard,
  github: GitBranch, database: Database, image: Image, brain: Brain, plug: Plug, tool: Wrench,
};

export function ToolIcon({ name, size = 12, color = '#6366f1' }: { name: IconName; size?: number; color?: string }) {
  const Cmp = MAP[name] ?? Wrench;
  return <Cmp size={size} color={color} />;
}
