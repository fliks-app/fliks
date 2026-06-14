{
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
}
