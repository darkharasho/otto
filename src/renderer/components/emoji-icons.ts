import emojiRegex from 'emoji-regex';
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
} from 'lucide-react';

// Emoji → Lucide icon. Curated for what assistant messages typically reach
// for; everything not in here falls through to OpenMoji Black (a free,
// comprehensive monochrome line-art SVG set) so coverage stays at 100% with
// a consistent line-icon aesthetic.
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
  '🐚': Terminal, // shell (bash/zsh)
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
  '⬆️📤': Upload,
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
  // Faces and most hand gestures are intentionally NOT mapped — Lucide only
  // has a handful of generic face/hand icons, so mapping all 70+ Unicode
  // faces onto them looked like every emoji had been replaced with the same
  // four glyphs. OpenMoji has unique line art per emoji, so we let those
  // fall through. Keep only the strong-semantic ones (👍/👎) where a Lucide
  // icon is universally recognized and reads cleaner than OpenMoji's art.
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

// Comprehensive emoji matcher (Unicode-spec accurate) — matches *any* emoji,
// not just the ones we have Lucide mappings for. The renderer falls back to
// a Twemoji SVG for unmapped graphemes so coverage is 100%.
export function makeEmojiRegex(): RegExp {
  return emojiRegex();
}

// Microsoft's Fluent UI Emoji "High Contrast" set is a coherent monochrome
// line-style emoji collection — comprehensive enough to cover ~all common
// emojis with the same visual language. Served via Iconify's CDN.
//
// Icon names follow the Unicode CLDR slug with underscores → hyphens (e.g.
// 😂 "face_with_tears_of_joy" → fluent-emoji-high-contrast/face-with-tears-of-joy).
import emojiData from 'unicode-emoji-json/data-by-emoji.json';

const SKIN_TONE_RANGE = /[\u{1F3FB}-\u{1F3FF}]/gu;

interface EmojiEntry {
  name: string;
  slug: string;
}
const EMOJI_DATA = emojiData as Record<string, EmojiEntry>;

export function fluentEmojiSlug(emoji: string): string | null {
  const entry = EMOJI_DATA[emoji];
  if (entry) return entry.slug.replace(/_/g, '-');
  // Try again with skin-tone modifiers stripped — those graphemes are not
  // separate entries; the base emoji is what's keyed in the data.
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
