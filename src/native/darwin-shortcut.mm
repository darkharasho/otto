#import <Cocoa/Cocoa.h>
#include <napi.h>
#include <CoreGraphics/CoreGraphics.h>

/**
 * Native Node addon that registers a global keyboard shortcut on macOS using
 * a CGEvent tap. This is the most reliable mechanism for global hotkeys.
 *
 * Requires Accessibility permission:
 *   - Prod (signed app): macOS prompts automatically.
 *   - Dev: manually add Electron.app in System Settings > Privacy & Security > Accessibility.
 */

static Napi::ThreadSafeFunction g_callback;
static CFMachPortRef g_tap = nullptr;
static CFRunLoopSourceRef g_runLoopSource = nullptr;
static int g_targetKeyCode = -1;
static CGEventFlags g_requiredMods = 0;

// Map of key names to macOS virtual key codes.
static int keyCodeForName(const std::string& name) {
    static const std::unordered_map<std::string, int> codes = {
        {"space", 49}, {"return", 36}, {"enter", 76}, {"tab", 48},
        {"escape", 53}, {"delete", 51}, {"backspace", 51},
        {"left", 123}, {"right", 124}, {"down", 125}, {"up", 126},
        {"home", 115}, {"end", 119}, {"pageup", 116}, {"pagedown", 121},
        {"f1", 122}, {"f2", 120}, {"f3", 99}, {"f4", 118}, {"f5", 96},
        {"f6", 97}, {"f7", 98}, {"f8", 100}, {"f9", 101}, {"f10", 109},
        {"f11", 103}, {"f12", 111},
        {"a", 0}, {"b", 11}, {"c", 8}, {"d", 2}, {"e", 14}, {"f", 3},
        {"g", 5}, {"h", 4}, {"i", 34}, {"j", 38}, {"k", 40}, {"l", 37},
        {"m", 46}, {"n", 45}, {"o", 31}, {"p", 35}, {"q", 12}, {"r", 15},
        {"s", 1}, {"t", 17}, {"u", 32}, {"v", 9}, {"w", 13}, {"x", 7},
        {"y", 16}, {"z", 6},
        {"0", 29}, {"1", 18}, {"2", 19}, {"3", 20}, {"4", 21}, {"5", 23},
        {"6", 22}, {"7", 26}, {"8", 28}, {"9", 25},
        {"-", 27}, {"=", 24}, {"[", 33}, {"]", 30}, {"\\", 42},
        {";", 41}, {"'", 39}, {",", 43}, {".", 47}, {"/", 44}, {"`", 50},
    };
    auto it = codes.find(name);
    return it != codes.end() ? it->second : -1;
}

static std::string toLower(const std::string& s) {
    std::string r = s;
    for (auto& c : r) c = std::tolower(c);
    return r;
}

// Parse "Ctrl+Shift+Space" into keyCode + CGEvent modifier flags.
static bool parseCombo(const std::string& combo, int& outKey, CGEventFlags& outMods) {
    outMods = 0;
    outKey = -1;

    std::string current;
    std::vector<std::string> parts;
    for (char c : combo) {
        if (c == '+') {
            parts.push_back(toLower(current));
            current.clear();
        } else {
            current += c;
        }
    }
    if (!current.empty()) parts.push_back(toLower(current));

    for (const auto& part : parts) {
        if (part == "ctrl" || part == "control") {
            outMods |= kCGEventFlagMaskControl;
        } else if (part == "shift") {
            outMods |= kCGEventFlagMaskShift;
        } else if (part == "alt" || part == "option" || part == "opt") {
            outMods |= kCGEventFlagMaskAlternate;
        } else if (part == "cmd" || part == "command" || part == "meta" || part == "super") {
            outMods |= kCGEventFlagMaskCommand;
        } else {
            outKey = keyCodeForName(part);
            if (outKey < 0) return false;
        }
    }
    return outKey >= 0;
}

// CGEvent tap callback — runs on the main run loop.
static CGEventRef eventTapCallback(
    CGEventTapProxy /*proxy*/,
    CGEventType type,
    CGEventRef event,
    void* /*userInfo*/
) {
    // If the tap gets disabled by the system (e.g. timeout), re-enable it.
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        if (g_tap) CGEventTapEnable(g_tap, true);
        return event;
    }

    if (type != kCGEventKeyDown) return event;

    int64_t keyCode = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    if (keyCode != g_targetKeyCode) return event;

    CGEventFlags flags = CGEventGetFlags(event);
    CGEventFlags modMask = kCGEventFlagMaskControl | kCGEventFlagMaskShift |
                           kCGEventFlagMaskAlternate | kCGEventFlagMaskCommand;
    if ((flags & modMask) == g_requiredMods) {
        g_callback.NonBlockingCall();
        return nullptr;
    }

    return event;
}

// Register a global shortcut. Args: (combo: string, callback: () => void)
static Napi::Value Register(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsFunction()) {
        Napi::TypeError::New(env, "Expected (combo: string, callback: function)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Unregister any existing tap first.
    if (g_runLoopSource) {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), g_runLoopSource, kCFRunLoopCommonModes);
        CFRelease(g_runLoopSource);
        g_runLoopSource = nullptr;
    }
    if (g_tap) {
        CGEventTapEnable(g_tap, false);
        CFRelease(g_tap);
        g_tap = nullptr;
    }
    if (g_callback) {
        g_callback.Release();
    }

    std::string combo = info[0].As<Napi::String>().Utf8Value();

    if (!parseCombo(combo, g_targetKeyCode, g_requiredMods)) {
        Napi::Error::New(env, "Failed to parse key combo: " + combo).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Check Accessibility permission.
    if (!AXIsProcessTrusted()) {
        // Return false — caller should guide user to grant permission.
        return Napi::Boolean::New(env, false);
    }

    // Create a thread-safe callback so we can invoke JS from the CGEvent handler.
    g_callback = Napi::ThreadSafeFunction::New(
        env, info[1].As<Napi::Function>(), "darwin-shortcut", 0, 1
    );

    // Create a CGEvent tap listening for key-down events.
    // Try passive (listen-only) first — macOS 26 may restrict active taps.
    g_tap = CGEventTapCreate(
        kCGSessionEventTap,
        kCGHeadInsertEventTap,
        kCGEventTapOptionListenOnly,
        CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventFlagsChanged),
        eventTapCallback,
        nullptr
    );
    if (!g_tap) {
        g_callback.Release();
        return Napi::Boolean::New(env, false);
    }

    g_runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, g_tap, 0);
    CFRunLoopAddSource(CFRunLoopGetMain(), g_runLoopSource, kCFRunLoopCommonModes);
    CGEventTapEnable(g_tap, true);

    return Napi::Boolean::New(env, true);
}

// Check if the process has Accessibility permission.
static Napi::Value IsAccessibilityTrusted(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), AXIsProcessTrusted());
}

// Prompt for Accessibility permission (shows system dialog if not yet decided).
static Napi::Value PromptAccessibility(const Napi::CallbackInfo& info) {
    NSDictionary* opts = @{(__bridge NSString*)kAXTrustedCheckOptionPrompt: @YES};
    bool trusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)opts);
    return Napi::Boolean::New(info.Env(), trusted);
}

// Unregister the global shortcut.
static Napi::Value Unregister(const Napi::CallbackInfo& info) {
    if (g_runLoopSource) {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), g_runLoopSource, kCFRunLoopCommonModes);
        CFRelease(g_runLoopSource);
        g_runLoopSource = nullptr;
    }
    if (g_tap) {
        CGEventTapEnable(g_tap, false);
        CFRelease(g_tap);
        g_tap = nullptr;
    }
    if (g_callback) {
        g_callback.Release();
    }
    return info.Env().Undefined();
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("register", Napi::Function::New(env, Register));
    exports.Set("unregister", Napi::Function::New(env, Unregister));
    exports.Set("isAccessibilityTrusted", Napi::Function::New(env, IsAccessibilityTrusted));
    exports.Set("promptAccessibility", Napi::Function::New(env, PromptAccessibility));
    return exports;
}

NODE_API_MODULE(darwin_shortcut, Init)
