import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Award,
  Ban,
  Bell,
  BookOpen,
  Bookmark,
  Brain,
  Brush,
  Bug,
  Camera,
  CheckCircle2,
  Check,
  ChevronRight,
  ThumbsDown,
  ThumbsUp,
  CircleDot,
  Clapperboard,
  Clipboard,
  Clock,
  Cloud,
  Code,
  Cog,
  Compass,
  Construction,
  Crown,
  Database,
  Download,
  Eye,
  Filter,
  Flag,
  Flame,
  FlaskConical,
  Folder,
  GitBranch,
  Globe,
  Hammer,
  HardDrive,
  Heart,
  HelpCircle,
  Image,
  Info,
  Key,
  Lightbulb,
  Link,
  List,
  Lock,
  Mail,
  Map,
  MapPin,
  Megaphone,
  MessageSquare,
  Music,
  Package,
  Palette,
  PartyPopper,
  Pause,
  Pencil,
  Phone,
  Pin,
  Play,
  Pointer,
  Power,
  Puzzle,
  RefreshCw,
  Rocket,
  Save,
  Scale,
  Scissors,
  Search,
  Send,
  Settings,
  Shield,
  ShieldAlert,
  Sparkles,
  Star,
  Sun,
  Tag,
  Target,
  Terminal,
  Trash2,
  TrendingDown,
  TrendingUp,
  Trophy,
  Umbrella,
  Upload,
  User,
  Users,
  Wand2,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react-native';

// ---------------------------------------------------------------------------
// Layer 1: Emoji → Lucide icon mapping (same as desktop emoji-icons.ts)
// ---------------------------------------------------------------------------

export const EMOJI_TO_ICON: Record<string, LucideIcon> = {
  // status / outcomes
  '✅': CheckCircle2,
  '☑️': CheckCircle2,
  '✔️': Check,
  '✓': Check,
  '❌': X,
  '✖️': X,
  '⛔': Ban,
  '🚫': Ban,
  '⚠️': AlertTriangle,
  'ℹ️': Info,
  '❗': AlertCircle,
  '❕': AlertCircle,

  // ideas / actions
  '💡': Lightbulb,
  '✨': Sparkles,
  '🪄': Wand2,
  '🚀': Rocket,
  '🔥': Flame,
  '⚡': Zap,
  '🏆': Trophy,
  '🥇': Award,

  // dev / tooling
  '🐛': Bug,
  '🔧': Wrench,
  '🔨': Hammer,
  '⚙️': Cog,
  '🛠️': Settings,
  '🧪': FlaskConical,
  '🧩': Puzzle,
  '🌿': GitBranch,
  '🌐': Globe,
  '🔗': Link,
  '💻': Terminal,
  '⌨️': Terminal,
  '🖥️': Terminal,
  '🐚': Terminal,
  '🪜': List,
  '✂️': Scissors,
  '🧱': Construction,
  '🏗️': Construction,
  '🪛': Wrench,
  '⚖️': Scale,
  '🧹': Brush,
  '🎨': Palette,
  '🧠': Brain,
  '🪞': RefreshCw,
  '🔄': RefreshCw,
  '🔁': RefreshCw,
  '🔃': RefreshCw,
  '👨‍💻': Code,
  '👩‍💻': Code,

  // files / data
  '📁': Folder,
  '📂': Folder,
  '📦': Package,
  '🏷️': Tag,
  '📌': Pin,
  '📎': Clipboard,
  '📋': Clipboard,
  '📝': Pencil,
  '✏️': Pencil,
  '🖊️': Pencil,
  '💾': Save,
  '💿': Save,
  '💽': HardDrive,
  '🗄️': Database,
  '🗃️': Database,
  '🗑️': Trash2,
  '📚': BookOpen,
  '📖': BookOpen,
  '📕': BookOpen,
  '📗': BookOpen,
  '📘': BookOpen,
  '📙': BookOpen,
  '📔': BookOpen,
  '📒': BookOpen,
  '🖼️': Image,
  '📸': Camera,
  '📷': Camera,
  '🎬': Clapperboard,
  '📊': TrendingUp,
  '📈': TrendingUp,
  '📉': TrendingDown,
  '☁️': Cloud,
  '📤': Upload,
  '📥': Download,

  // people / comms
  '💬': MessageSquare,
  '🗨️': MessageSquare,
  '🗯️': MessageSquare,
  '📣': Megaphone,
  '📢': Megaphone,
  '🔔': Bell,
  '📞': Phone,
  '📧': Mail,
  '✉️': Mail,
  '📨': Send,
  '📩': Send,
  '👍': ThumbsUp,
  '👎': ThumbsDown,
  '❤️': Heart,
  '💖': Heart,
  '👤': User,
  '👥': Users,
  '👑': Crown,

  // nav / pointer
  '👉': ChevronRight,
  '👆': ArrowUp,
  '👇': ArrowDown,
  '👈': ArrowLeft,
  '➡️': ArrowRight,
  '⬅️': ArrowLeft,
  '⬆️': ArrowUp,
  '⬇️': ArrowDown,
  '🔼': ArrowUp,
  '🔽': ArrowDown,
  '🖱️': Pointer,

  // time / state
  '⏰': Clock,
  '⏱️': Clock,
  '🕐': Clock,
  '⏳': Clock,
  '⌛': Clock,
  '▶️': Play,
  '⏸️': Pause,
  '⏹️': Power,
  '🎵': Music,

  // meta
  '🔍': Search,
  '🔎': Search,
  '👀': Eye,
  '🔒': Lock,
  '🔓': Lock,
  '🔑': Key,
  '🗝️': Key,
  '🛡️': Shield,
  '🚨': ShieldAlert,
  '⭐': Star,
  '🌟': Star,
  '☀️': Sun,
  '☂️': Umbrella,
  '🚩': Flag,
  '🏁': Flag,
  '📍': MapPin,
  '🗺️': Map,
  '🧭': Compass,
  '🔖': Bookmark,
  '🎯': Target,
  '⚓': CircleDot,
  '🎉': PartyPopper,
  '🎊': PartyPopper,
  '🔂': Filter,
  '❓': HelpCircle,
  '❔': HelpCircle,
};

// ---------------------------------------------------------------------------
// Layer 2: Fluent UI Emoji High Contrast — monochrome SVGs via Iconify CDN
// (same approach as desktop: unicode-emoji-json for slug lookup)
// ---------------------------------------------------------------------------

import emojiData from 'unicode-emoji-json/data-by-emoji.json';

const SKIN_TONE_RANGE = /[\u{1F3FB}-\u{1F3FF}]/gu;

interface EmojiEntry { name: string; slug: string }
const EMOJI_DATA = emojiData as Record<string, EmojiEntry>;

export function fluentEmojiSlug(emoji: string): string | null {
  const entry = EMOJI_DATA[emoji];
  if (entry) return entry.slug.replace(/_/g, '-');
  // Try again with skin-tone modifiers stripped
  const stripped = emoji.replace(SKIN_TONE_RANGE, '');
  if (stripped !== emoji) {
    const baseEntry = EMOJI_DATA[stripped];
    if (baseEntry) return baseEntry.slug.replace(/_/g, '-');
  }
  return null;
}

export function fluentEmojiUrl(emoji: string): string | null {
  const slug = fluentEmojiSlug(emoji);
  if (!slug) return null;
  return `https://api.iconify.design/fluent-emoji-high-contrast/${slug}.svg`;
}

// ---------------------------------------------------------------------------
// Emoji regex & segment splitting
// ---------------------------------------------------------------------------

// Broad regex matching most Unicode emoji.
const ALL_EMOJI_RE =
  /(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(?:\u200D(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*/gu;

export interface TextSegment { type: 'text'; value: string }
export interface LucideSegment { type: 'lucide'; emoji: string; Icon: LucideIcon }
export interface FluentSegment { type: 'fluent'; emoji: string; url: string }
export type Segment = TextSegment | LucideSegment | FluentSegment;

/**
 * Split a string into text, Lucide-icon, and Fluent-emoji segments.
 *
 * Layer 1 — mapped emoji → Lucide icon (purple, instant, no network).
 * Layer 2 — unmapped emoji with a Fluent slug → CDN SVG URL.
 * Layer 3 — truly unknown emoji → stripped (render nothing).
 */
export function splitEmoji(text: string): Segment[] {
  const segments: Segment[] = [];
  ALL_EMOJI_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = ALL_EMOJI_RE.exec(text)) !== null) {
    if (m.index > last) segments.push({ type: 'text', value: text.slice(last, m.index) });

    const Icon = EMOJI_TO_ICON[m[0]];
    if (Icon !== undefined) {
      segments.push({ type: 'lucide', emoji: m[0], Icon });
    } else {
      const url = fluentEmojiUrl(m[0]);
      if (url) {
        segments.push({ type: 'fluent', emoji: m[0], url });
      }
      // Layer 3: no Lucide icon, no Fluent slug → drop silently.
    }

    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ type: 'text', value: text.slice(last) });
  return segments;
}

/** Quick check whether text contains any emoji (mapped or not). */
export function hasEmojiIcon(text: string): boolean {
  ALL_EMOJI_RE.lastIndex = 0;
  return ALL_EMOJI_RE.test(text);
}
