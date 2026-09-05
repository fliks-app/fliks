{
  # One native unit per desktop OS, selected by top-level conditions so the
  # wrong-OS target (and its toolchain probes) never even resolve:
  #   - linux → fliks_compositor: SDL2/GLES/EGL self-compositor (pkg-config).
  #     Its `<!@(pkg-config sdl2 …)` would FAIL at gyp time on macOS, hence the
  #     condition gate rather than a per-target no-op.
  #   - mac   → fliks_player_mac: in-process libmpv rendering offscreen via GL
  #     into an IOSurface, blit-copied by Metal into a CAMetalLayer on the
  #     Electron videoWin's NSView (Cocoa/QuartzCore/OpenGL/Metal/IOSurface).
  # Windows ships no addon (it embeds an mpv subprocess via --wid).
  "targets": [],
  "conditions": [
    ["OS=='linux'", {
      "targets": [
        {
          "target_name": "fliks_compositor",
          "sources": [
            "compositor/addon.cc"
          ],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include_dir\")",
            "<!@(pkg-config --cflags-only-I sdl2 glesv2 egl mpv | sed 's/-I//g')"
          ],
          "libraries": [
            "<!@(pkg-config --libs sdl2 glesv2 egl)",
            "-ldl"
          ],
          "cflags_cc": [ "-std=c++17", "-fexceptions" ],
          "defines": [ "NAPI_VERSION=8", "NAPI_CPP_EXCEPTIONS" ]
        }
      ]
    }],
    ["OS=='mac'", {
      "targets": [
        {
          "target_name": "fliks_player_mac",
          "sources": [
            "player_mac/addon.mm"
          ],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include_dir\")",
            # libmpv headers (mpv/client.h, render.h, render_gl.h). Apple Silicon
            # Homebrew prefix; CI installs mpv to get these. Override via the
            # FLIKS_MPV_INCLUDE env if libmpv lives elsewhere.
            "<!@(node -e \"process.stdout.write(process.env.FLIKS_MPV_INCLUDE || '/opt/homebrew/include')\")"
          ],
          "libraries": [
            "-framework Cocoa",
            "-framework QuartzCore",
            "-framework OpenGL",
            "-framework Metal",
            "-framework IOSurface",
            "-framework CoreVideo",
            "-framework CoreFoundation",
            "-ldl"
          ],
          "defines": [ "NAPI_VERSION=8", "NAPI_CPP_EXCEPTIONS" ],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "11.0"
          }
        }
      ]
    }]
  ]
}
