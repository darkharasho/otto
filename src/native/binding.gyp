{
  "targets": [
    {
      "target_name": "darwin_shortcut",
      "conditions": [
        ["OS=='mac'", {
          "sources": ["darwin-shortcut.mm"],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")"
          ],
          "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "OTHER_CPLUSPLUSFLAGS": ["-std=c++17"],
            "MACOSX_DEPLOYMENT_TARGET": "11.0"
          },
          "link_settings": {
            "libraries": ["-framework Cocoa", "-framework ApplicationServices"]
          }
        }]
      ]
    }
  ]
}
