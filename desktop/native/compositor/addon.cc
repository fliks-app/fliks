// fliks_compositor — native single-window GL compositor (Electron+mpv, Option C).
//
// One SDL3/GL window. mpv (self-contained libmpv, plain dlopen — FFmpeg
// statically linked + symbols hidden, so no clash with Electron's libffmpeg)
// renders video via the RENDER API into a GL FBO; the Electron OSR UI bitmap is
// uploaded to a GL texture; both are composited (video then UI, premult-alpha)
// into the window. Three threads: Node/main (N-API), render (GL ctx), and mpv
// event poll. mpv FBO + OSR UI are both top-down → flipped in-shader (mpv's
// FLIP_Y param is unsupported); UI is BGRA → swizzled.
#define _GNU_SOURCE 1
#include <napi.h>

#include <SDL3/SDL.h>
// Desktop GL, not GLES: mpv drops RA_CAP_COMPUTE on any GLES context (ra_gl.c
// disables it unconditionally), which costs HDR peak detection. Mesa's libGL
// exports the 2.0+ entry points, so glext's prototypes are enough, no loader.
#define GL_GLEXT_PROTOTYPES
#include <GL/gl.h>
#include <GL/glext.h>

#include <mpv/client.h>
#include <mpv/render.h>
#include <mpv/render_gl.h>

#include <dlfcn.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

// ── dlopen'd self-contained libmpv ───────────────────────────────────────────
namespace M {
mpv_handle* (*create)(void) = nullptr;
int (*set_option_string)(mpv_handle*, const char*, const char*) = nullptr;
int (*set_property_string)(mpv_handle*, const char*, const char*) = nullptr;
char* (*get_property_string)(mpv_handle*, const char*) = nullptr;
int (*get_property)(mpv_handle*, const char*, mpv_format, void*) = nullptr;
int (*observe_property)(mpv_handle*, uint64_t, const char*, mpv_format) = nullptr;
int (*request_log_messages)(mpv_handle*, const char*) = nullptr;
void (*mpv_free)(void*) = nullptr;
int (*initialize)(mpv_handle*) = nullptr;
int (*command)(mpv_handle*, const char**) = nullptr;
int (*command_async)(mpv_handle*, uint64_t, const char**) = nullptr;
mpv_event* (*wait_event)(mpv_handle*, double) = nullptr;
void (*destroy)(mpv_handle*) = nullptr;
const char* (*error_string)(int) = nullptr;
int (*rc_create)(mpv_render_context**, mpv_handle*, mpv_render_param*) = nullptr;
void (*rc_set_update_callback)(mpv_render_context*, mpv_render_update_fn, void*) = nullptr;
uint64_t (*rc_update)(mpv_render_context*) = nullptr;
int (*rc_render)(mpv_render_context*, mpv_render_param*) = nullptr;
void (*rc_report_swap)(mpv_render_context*) = nullptr;
void (*rc_free)(mpv_render_context*) = nullptr;

bool Load() {
  if (create) return true;
  const char* path = getenv("FLIKS_MPV_PATH");
  if (!path) path = "libmpv.so.2";
  void* h = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (!h) {
    fprintf(stderr, "[compositor] dlopen libmpv failed: %s\n", dlerror());
    return false;
  }
  fprintf(stderr, "[compositor] libmpv loaded: %s\n", path);
#define SYM(field, name)                                     \
  field = reinterpret_cast<decltype(field)>(dlsym(h, name)); \
  if (!field) { fprintf(stderr, "[compositor] missing %s\n", name); return false; }
  SYM(create, "mpv_create")
  SYM(set_option_string, "mpv_set_option_string")
  SYM(set_property_string, "mpv_set_property_string")
  SYM(get_property_string, "mpv_get_property_string")
  SYM(get_property, "mpv_get_property")
  SYM(observe_property, "mpv_observe_property")
  SYM(request_log_messages, "mpv_request_log_messages")
  SYM(mpv_free, "mpv_free")
  SYM(initialize, "mpv_initialize")
  SYM(command, "mpv_command")
  SYM(command_async, "mpv_command_async")
  SYM(wait_event, "mpv_wait_event")
  SYM(destroy, "mpv_terminate_destroy")
  SYM(error_string, "mpv_error_string")
  SYM(rc_create, "mpv_render_context_create")
  SYM(rc_set_update_callback, "mpv_render_context_set_update_callback")
  SYM(rc_update, "mpv_render_context_update")
  SYM(rc_render, "mpv_render_context_render")
  SYM(rc_report_swap, "mpv_render_context_report_swap")
  SYM(rc_free, "mpv_render_context_free")
#undef SYM
  return true;
}
}  // namespace M

// ── thread-safe event marshalling to JS ──────────────────────────────────────
void CallJs(Napi::Env env, Napi::Function cb, void*, std::string* data) {
  if (env != nullptr && cb != nullptr) cb.Call({Napi::String::New(env, *data)});
  delete data;
}
using EventTSFN = Napi::TypedThreadSafeFunction<void, std::string, CallJs>;
EventTSFN g_tsfn;        // mpv events → JS
EventTSFN g_inputTsfn;   // SDL input → JS (forwarded to the OSR webContents)
std::atomic<bool> g_tsfnReady{false};
std::atomic<bool> g_inputReady{false};

struct GlState {
  SDL_Window* window = nullptr;
  SDL_GLContext gl = nullptr;
  int width = 1280;
  int height = 800;
  std::string title = "Fliks";
  std::string iconPath;  // BMP loaded onto the window via SDL_SetWindowIcon
  std::atomic<bool> run{false};
  std::atomic<int> fsRequest{-1};  // -1 none, 0 windowed, 1 fullscreen-desktop
  std::atomic<int> cursorRequest{-1};  // -1 none, 0 hidden, 1 shown
  std::atomic<int> cursorShape{-1};    // -1 none, else an index into kCursors
  std::thread renderThread;
  std::thread eventThread;

  GLuint program = 0;
  GLuint chrome = 0;
  GLuint vao = 0;
  GLuint uiTex = 0;
  GLuint videoTex = 0;
  GLuint videoFbo = 0;
  int fboW = 0;
  int fboH = 0;

  std::mutex uiMutex;
  std::vector<uint8_t> uiPending;
  int uiW = 0;
  int uiH = 0;
  bool uiDirty = false;
  bool uiResized = false;
  int uiDx0 = 0, uiDy0 = 0, uiDx1 = 0, uiDy1 = 0;  // union of the unuploaded dirty rects

  mpv_handle* mpv = nullptr;
  mpv_render_context* mpvGl = nullptr;
  double duration = 0;
  std::atomic<bool> paused{false};
};

GlState g_state;

const char* kVert = R"(#version 430 core
out vec2 v_uv;
uniform float u_flipY;
void main() {
  vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0,
                float((gl_VertexID & 2) << 1) - 1.0);
  gl_Position = vec4(p, 0.0, 1.0);
  float ty = p.y * 0.5 + 0.5;
  v_uv = vec2(p.x * 0.5 + 0.5, (u_flipY > 0.5) ? (1.0 - ty) : ty);
}
)";

const char* kFrag = R"(#version 430 core
in vec2 v_uv;
uniform sampler2D u_tex;
uniform int u_bgra;
out vec4 frag;
void main() {
  vec4 c = texture(u_tex, v_uv);
  frag = (u_bgra == 1) ? c.bgra : c;
}
)";

// The title bar (u_bar > 0) or, over the whole window, the alpha of its rounded corners.
const char* kChromeFrag = R"(#version 430 core
uniform vec2 u_win;
uniform float u_pt;
uniform float u_bar;
uniform float u_radius;
uniform vec3 u_btn;
uniform int u_hover;
uniform int u_pressed;
uniform int u_maximized;
out vec4 frag;

float box(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float seg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, u_win.y - gl_FragCoord.y);
  if (u_bar == 0.0) {
    frag = vec4(0.0, 0.0, 0.0, clamp(0.5 - box(p - u_win * 0.5, u_win * 0.5, u_radius), 0.0, 1.0));
    return;
  }
  vec3 c = vec3(0.114, 0.137, 0.165);  // the client's base-100
  for (int i = 0; i < 3; i++) {
    vec2 center = vec2(u_win.x / u_pt - u_btn.z - u_btn.x * (float(i) + 0.5) - u_btn.y * float(i),
                       u_bar / u_pt * 0.5);
    vec2 q = p / u_pt - center;
    float disc = clamp(0.5 - (length(q) - u_btn.x * 0.5) * u_pt, 0.0, 1.0);
    c = mix(c, vec3(1.0), disc * (i == u_pressed ? 0.24 : i == u_hover ? 0.16 : 0.08));
    float d;
    if (i == 0) {
      d = min(seg(q, vec2(-4.0), vec2(4.0)), seg(q, vec2(-4.0, 4.0), vec2(4.0, -4.0)));
    } else if (i == 2) {
      d = seg(q, vec2(-4.0, 3.5), vec2(4.0, 3.5));
    } else if (u_maximized == 0) {
      d = abs(box(q, vec2(4.0), 1.0));
    } else {
      float front = box(q - vec2(-1.5, 1.5), vec2(3.0), 0.5);
      d = min(abs(front), front < 0.0 ? 1e9 : abs(box(q - vec2(1.5, -1.5), vec2(3.0), 0.5)));
    }
    c = mix(c, vec3(0.93), clamp(0.5 - (d - 0.75) * u_pt, 0.0, 1.0));
  }
  frag = vec4(c, 1.0);
}
)";

GLuint Compile(GLenum type, const char* src) {
  GLuint s = glCreateShader(type);
  glShaderSource(s, 1, &src, nullptr);
  glCompileShader(s);
  GLint ok = 0;
  glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char log[1024];
    glGetShaderInfoLog(s, sizeof(log), nullptr, log);
    fprintf(stderr, "[compositor] shader compile error: %s\n", log);
  }
  return s;
}

GLuint LinkProgram(const char* vs, const char* fs) {
  GLuint v = Compile(GL_VERTEX_SHADER, vs);
  GLuint f = Compile(GL_FRAGMENT_SHADER, fs);
  GLuint p = glCreateProgram();
  glAttachShader(p, v);
  glAttachShader(p, f);
  glLinkProgram(p);
  glDeleteShader(v);
  glDeleteShader(f);
  return p;
}

void EnsureVideoFbo(GlState* s, int w, int h) {
  if (s->videoFbo && s->fboW == w && s->fboH == h) return;
  if (!s->videoTex) glGenTextures(1, &s->videoTex);
  if (!s->videoFbo) glGenFramebuffers(1, &s->videoFbo);
  glBindTexture(GL_TEXTURE_2D, s->videoTex);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glBindFramebuffer(GL_FRAMEBUFFER, s->videoFbo);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, s->videoTex, 0);
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  s->fboW = w;
  s->fboH = h;
}

void DrawTex(GlState* s, GLuint tex, float flipY, int bgra) {
  glUseProgram(s->program);
  glActiveTexture(GL_TEXTURE0);
  glBindTexture(GL_TEXTURE_2D, tex);
  glUniform1i(glGetUniformLocation(s->program, "u_tex"), 0);
  glUniform1f(glGetUniformLocation(s->program, "u_flipY"), flipY);
  glUniform1i(glGetUniformLocation(s->program, "u_bgra"), bgra);
  glBindVertexArray(s->vao);
  glDrawArrays(GL_TRIANGLES, 0, 3);
}

void InitGl(GlState* s) {
  s->program = LinkProgram(kVert, kFrag);
  s->chrome = LinkProgram(kVert, kChromeFrag);
  glGenVertexArrays(1, &s->vao);
  glGenTextures(1, &s->uiTex);
  glBindTexture(GL_TEXTURE_2D, s->uiTex);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
}

void* GetProc(void*, const char* name) { return reinterpret_cast<void*>(SDL_GL_GetProcAddress(name)); }
void OnMpvUpdate(void*) { /* continuous render loop polls rc_update */ }

void MpvRenderInit(GlState* s) {
  if (!s->mpv) return;
  mpv_opengl_init_params gl_init{};
  gl_init.get_proc_address = GetProc;
  gl_init.get_proc_address_ctx = nullptr;
  int advanced = 1;
  mpv_render_param params[] = {
      {MPV_RENDER_PARAM_API_TYPE, const_cast<char*>(MPV_RENDER_API_TYPE_OPENGL)},
      {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl_init},
      {MPV_RENDER_PARAM_ADVANCED_CONTROL, &advanced},
      {static_cast<mpv_render_param_type>(0), nullptr},
  };
  int rc = M::rc_create(&s->mpvGl, s->mpv, params);
  if (rc < 0) {
    fprintf(stderr, "[compositor] rc_create failed: %s\n", M::error_string(rc));
    return;
  }
  M::rc_set_update_callback(s->mpvGl, OnMpvUpdate, s);
  fprintf(stderr, "[compositor] mpv render context ready\n");
}

// Indexed by the shape ids main/index.ts maps Chromium's cursor names onto.
const SDL_SystemCursor kCursors[] = {SDL_SYSTEM_CURSOR_DEFAULT, SDL_SYSTEM_CURSOR_POINTER,
                                     SDL_SYSTEM_CURSOR_TEXT, SDL_SYSTEM_CURSOR_MOVE};
constexpr int kCursorCount = static_cast<int>(sizeof(kCursors) / sizeof(kCursors[0]));

// Window chrome in points, scaled by the display scale. Buttons run right to left:
// close, maximize, minimize.
constexpr float kBarHeight = 40, kButtonSize = 24, kButtonGap = 10, kButtonMargin = 8;
constexpr float kCornerRadius = 12, kResizeBorder = 6;
constexpr int kButtonCount = 3;

// Sizes in window units, the unit of SDL's mouse and hit-test coordinates.
struct Chrome {
  float pt = 1;  // window units per point
  float w = 0, h = 0, bar = 0;
  bool fullscreen = false, maximized = false;
};

Chrome ChromeOf(SDL_Window* win) {
  Chrome c;
  int w, h;
  SDL_GetWindowSize(win, &w, &h);
  c.w = static_cast<float>(w);
  c.h = static_cast<float>(h);
  const float density = SDL_GetWindowPixelDensity(win);
  const float scale = SDL_GetWindowDisplayScale(win);
  c.pt = (scale > 0 ? scale : 1) / (density > 0 ? density : 1);
  const SDL_WindowFlags f = SDL_GetWindowFlags(win);
  c.fullscreen = f & SDL_WINDOW_FULLSCREEN;
  c.maximized = f & SDL_WINDOW_MAXIMIZED;
  c.bar = c.fullscreen ? 0 : kBarHeight * c.pt;
  return c;
}

int ButtonAt(const Chrome& c, float x, float y) {
  if (y >= c.bar) return -1;
  for (int i = 0; i < kButtonCount; i++) {
    const float cx = c.w - (kButtonMargin + kButtonSize * (i + 0.5f) + kButtonGap * i) * c.pt;
    if (std::abs(x - cx) <= (kButtonSize + kButtonGap) * c.pt / 2) return i;
  }
  return -1;
}

SDL_HitTestResult HitTest(SDL_Window* win, const SDL_Point* p, void*) {
  const Chrome c = ChromeOf(win);
  if (c.fullscreen) return SDL_HITTEST_NORMAL;
  if (!c.maximized) {
    const float edge = kResizeBorder * c.pt, corner = kCornerRadius * c.pt;
    const float x = static_cast<float>(p->x), y = static_cast<float>(p->y);
    const bool left = x < edge, right = x >= c.w - edge, top = y < edge, bottom = y >= c.h - edge;
    const bool nearLeft = x < corner, nearRight = x >= c.w - corner;
    const bool nearTop = y < corner, nearBottom = y >= c.h - corner;
    if ((top && nearLeft) || (left && nearTop)) return SDL_HITTEST_RESIZE_TOPLEFT;
    if ((top && nearRight) || (right && nearTop)) return SDL_HITTEST_RESIZE_TOPRIGHT;
    if ((bottom && nearLeft) || (left && nearBottom)) return SDL_HITTEST_RESIZE_BOTTOMLEFT;
    if ((bottom && nearRight) || (right && nearBottom)) return SDL_HITTEST_RESIZE_BOTTOMRIGHT;
    if (top) return SDL_HITTEST_RESIZE_TOP;
    if (bottom) return SDL_HITTEST_RESIZE_BOTTOM;
    if (left) return SDL_HITTEST_RESIZE_LEFT;
    if (right) return SDL_HITTEST_RESIZE_RIGHT;
  }
  return p->y < c.bar && ButtonAt(c, p->x, p->y) < 0 ? SDL_HITTEST_DRAGGABLE : SDL_HITTEST_NORMAL;
}

void DrawChrome(GlState* s, int w, int h, float pt, float bar, float radius, int hover, int pressed,
                bool maximized) {
  glUseProgram(s->chrome);
  glUniform2f(glGetUniformLocation(s->chrome, "u_win"), w, h);
  glUniform1f(glGetUniformLocation(s->chrome, "u_pt"), pt);
  glUniform1f(glGetUniformLocation(s->chrome, "u_bar"), bar);
  glUniform1f(glGetUniformLocation(s->chrome, "u_radius"), radius);
  glUniform3f(glGetUniformLocation(s->chrome, "u_btn"), kButtonSize, kButtonGap, kButtonMargin);
  glUniform1i(glGetUniformLocation(s->chrome, "u_hover"), hover);
  glUniform1i(glGetUniformLocation(s->chrome, "u_pressed"), pressed);
  glUniform1i(glGetUniformLocation(s->chrome, "u_maximized"), maximized ? 1 : 0);
  glBindVertexArray(s->vao);
  glDrawArrays(GL_TRIANGLES, 0, 3);
}

void RenderThreadMain(GlState* s) {
  SDL_Cursor* cursorCache[kCursorCount] = {};
  // The X11 WM_CLASS / Wayland app_id the dock matches to fliks.desktop, not "electron"
  // (argv0). An SDL_APP_ID set at launch wins.
  SDL_SetHint(SDL_HINT_APP_ID, "fliks");
  // Without this SDL swallows the click that refocuses the window, so the first
  // click back into the app lands on nothing and everything needs clicking twice.
  SDL_SetHint(SDL_HINT_MOUSE_FOCUS_CLICKTHROUGH, "1");
  if (!SDL_Init(SDL_INIT_VIDEO)) {
    fprintf(stderr, "[compositor] SDL_Init failed: %s\n", SDL_GetError());
    return;
  }
  // 4.3 core: mpv gates compute shaders on GLSL >= 420, and they drive its HDR
  // peak detection. The compositor's own GL surface is core-clean already.
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 4);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
  SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1);
  SDL_GL_SetAttribute(SDL_GL_ALPHA_SIZE, 8);
  // GNOME draws no frame around a Wayland window, so this one draws its own title bar
  // and rounds its corners through the alpha channel.
  s->window = SDL_CreateWindow(s->title.c_str(), s->width, s->height,
                               SDL_WINDOW_OPENGL | SDL_WINDOW_RESIZABLE | SDL_WINDOW_HIGH_PIXEL_DENSITY |
                                   SDL_WINDOW_BORDERLESS | SDL_WINDOW_TRANSPARENT);
  if (!s->window) {
    fprintf(stderr, "[compositor] SDL_CreateWindow failed: %s\n", SDL_GetError());
    SDL_Quit();
    return;
  }
  SDL_SetWindowHitTest(s->window, HitTest, nullptr);
  // Window icon (the dock/taskbar uses this when no .desktop matches). Loaded
  // from a BMP so SDL's core loader suffices — no SDL_image dependency.
  if (!s->iconPath.empty()) {
    if (SDL_Surface* icon = SDL_LoadBMP(s->iconPath.c_str())) {
      SDL_SetWindowIcon(s->window, icon);
      SDL_DestroySurface(icon);
    } else {
      fprintf(stderr, "[compositor] icon load failed (%s): %s\n",
              s->iconPath.c_str(), SDL_GetError());
    }
  }
  s->gl = SDL_GL_CreateContext(s->window);
  SDL_GL_MakeCurrent(s->window, s->gl);
  SDL_GL_SetSwapInterval(1);
  fprintf(stderr, "[compositor] GL %s | %s | %s\n", glGetString(GL_VERSION), glGetString(GL_RENDERER),
          SDL_GetCurrentVideoDriver());
  SDL_StartTextInput(s->window);
  InitGl(s);
  MpvRenderInit(s);

  auto emitInput = [](const std::string& j) {
    if (g_inputReady.load()) g_inputTsfn.BlockingCall(new std::string(j));
  };
  auto close = [s] {
    // Only the main process can quit Electron; without this the closed
    // window leaves it running and a relaunch shares the same profile.
    if (g_tsfnReady.load()) g_tsfn.BlockingCall(new std::string("{\"type\":\"closed\"}"));
    s->run.store(false);
  };
  char ib[256];
  int lastW = -1, lastH = -1;
  float lastZoom = -1;
  int hover = -1, pressed = -1;
  // A release goes where its press went, so a drag across the title bar edge stays whole.
  SDL_MouseButtonFlags barButtons = 0, pageButtons = 0;
  bool onPage = false;

  while (s->run.load(std::memory_order_acquire)) {
    const Chrome c = ChromeOf(s->window);
    const float density = SDL_GetWindowPixelDensity(s->window);
    // Window units → pixels of the page, which starts under the title bar.
    auto px = [&](float x) { return static_cast<int>(std::lround(x * density)); };
    auto py = [&](float y) { return static_cast<int>(std::lround((y - c.bar) * density)); };
    SDL_Event ev;
    while (SDL_PollEvent(&ev)) {
      switch (ev.type) {
        case SDL_EVENT_QUIT:
          close();
          break;
        case SDL_EVENT_WINDOW_MOUSE_LEAVE:
          hover = -1;
          if (onPage) emitInput("{\"kind\":\"leave\"}");
          onPage = false;
          break;
        case SDL_EVENT_MOUSE_MOTION:
          hover = ButtonAt(c, ev.motion.x, ev.motion.y);
          if (!pageButtons && ev.motion.y < c.bar) {
            if (onPage) emitInput("{\"kind\":\"leave\"}");
            onPage = false;
            break;
          }
          onPage = true;
          snprintf(ib, sizeof(ib), "{\"kind\":\"move\",\"x\":%d,\"y\":%d}", px(ev.motion.x), py(ev.motion.y));
          emitInput(ib);
          break;
        case SDL_EVENT_MOUSE_BUTTON_DOWN:
        case SDL_EVENT_MOUSE_BUTTON_UP: {
          const bool down = ev.type == SDL_EVENT_MOUSE_BUTTON_DOWN;
          const SDL_MouseButtonFlags mask = SDL_BUTTON_MASK(ev.button.button);
          const bool inBar = down ? ev.button.y < c.bar : (barButtons & mask) != 0;
          if (down) {
            (inBar ? barButtons : pageButtons) |= mask;
          } else {
            barButtons &= ~mask;
            pageButtons &= ~mask;
          }
          if (inBar) {
            const int b = ButtonAt(c, ev.button.x, ev.button.y);
            if (ev.button.button == SDL_BUTTON_LEFT && down) {
              pressed = b;
            } else if (ev.button.button == SDL_BUTTON_LEFT) {
              if (b == 0 && pressed == 0) close();
              if (b == 1 && pressed == 1) c.maximized ? SDL_RestoreWindow(s->window) : SDL_MaximizeWindow(s->window);
              if (b == 2 && pressed == 2) SDL_MinimizeWindow(s->window);
              pressed = -1;
            } else if (ev.button.button == SDL_BUTTON_RIGHT && down && b < 0) {
              SDL_ShowWindowSystemMenu(s->window, static_cast<int>(ev.button.x), static_cast<int>(ev.button.y));
            }
            break;
          }
          // Thumb buttons are navigation, not clicks; the main process turns
          // them into history moves rather than forwarding them to the page.
          const char* btn = ev.button.button == SDL_BUTTON_RIGHT    ? "right"
                            : ev.button.button == SDL_BUTTON_MIDDLE ? "middle"
                            : ev.button.button == SDL_BUTTON_X1     ? "back"
                            : ev.button.button == SDL_BUTTON_X2     ? "forward"
                                                                    : "left";
          snprintf(ib, sizeof(ib),
                   "{\"kind\":\"button\",\"down\":%s,\"x\":%d,\"y\":%d,\"button\":\"%s\",\"clicks\":%d}",
                   down ? "true" : "false", px(ev.button.x), py(ev.button.y), btn, ev.button.clicks);
          emitInput(ib);
          break;
        }
        case SDL_EVENT_MOUSE_WHEEL:
          if (ev.wheel.mouse_y < c.bar) break;
          snprintf(ib, sizeof(ib), "{\"kind\":\"wheel\",\"x\":%d,\"y\":%d,\"dx\":%.3f,\"dy\":%.3f}",
                   px(ev.wheel.mouse_x), py(ev.wheel.mouse_y), ev.wheel.x, ev.wheel.y);
          emitInput(ib);
          break;
        case SDL_EVENT_KEY_DOWN:
        case SDL_EVENT_KEY_UP: {
          snprintf(ib, sizeof(ib), "{\"kind\":\"key\",\"down\":%s,\"key\":\"%s\",\"mod\":%d}",
                   ev.type == SDL_EVENT_KEY_DOWN ? "true" : "false", SDL_GetKeyName(ev.key.key),
                   (int)ev.key.mod);
          emitInput(ib);
          break;
        }
        case SDL_EVENT_TEXT_INPUT: {
          // escape the text minimally for JSON
          std::string t = ev.text.text;
          std::string esc;
          for (char ch : t) {
            if (ch == '"' || ch == '\\') esc += '\\';
            esc += ch;
          }
          emitInput("{\"kind\":\"text\",\"text\":\"" + esc + "\"}");
          break;
        }
        default:
          break;
      }
    }
    int fs = s->fsRequest.exchange(-1, std::memory_order_acq_rel);
    if (fs >= 0) SDL_SetWindowFullscreen(s->window, fs == 1);
    // The page's CSS cursor only covers the offscreen bitmap; the pointer the
    // user sees belongs to this window.
    int cur = s->cursorRequest.exchange(-1, std::memory_order_acq_rel);
    if (cur >= 0) cur == 1 ? SDL_ShowCursor() : SDL_HideCursor();
    // Chromium resolves the CSS cursor for the page; only this window can show
    // it. Built on demand and kept, since a shape recurs on every hover.
    int shape = s->cursorShape.exchange(-1, std::memory_order_acq_rel);
    if (shape >= 0 && shape < kCursorCount) {
      if (!cursorCache[shape]) cursorCache[shape] = SDL_CreateSystemCursor(kCursors[shape]);
      if (cursorCache[shape]) SDL_SetCursor(cursorCache[shape]);
    }

    // The page renders in pixels and is zoomed by the display scale back to its CSS size.
    int w, h;
    SDL_GetWindowSizeInPixels(s->window, &w, &h);
    const int barPx = static_cast<int>(std::lround(c.bar * density));
    const int pageH = std::max(1, h - barPx);
    const float zoom = c.pt * density;
    if (w != lastW || pageH != lastH || zoom != lastZoom) {
      lastW = w;
      lastH = pageH;
      lastZoom = zoom;
      snprintf(ib, sizeof(ib), "{\"kind\":\"resize\",\"w\":%d,\"h\":%d,\"zoom\":%.4f}", w, pageH, zoom);
      emitInput(ib);
    }
    EnsureVideoFbo(s, w, pageH);

    if (s->mpvGl) {
      uint64_t flags = M::rc_update(s->mpvGl);
      if (flags & MPV_RENDER_UPDATE_FRAME) {
        mpv_opengl_fbo fbo{static_cast<int>(s->videoFbo), w, pageH, 0};
        mpv_render_param rp[] = {
            {MPV_RENDER_PARAM_OPENGL_FBO, &fbo},
            {static_cast<mpv_render_param_type>(0), nullptr},
        };
        M::rc_render(s->mpvGl, rp);
      }
    }

    {
      std::lock_guard<std::mutex> lk(s->uiMutex);
      if (s->uiDirty && !s->uiPending.empty()) {
        glBindTexture(GL_TEXTURE_2D, s->uiTex);
        glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
        if (s->uiResized) {
          glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, s->uiW, s->uiH, 0, GL_RGBA,
                       GL_UNSIGNED_BYTE, s->uiPending.data());
          s->uiResized = false;
        } else {
          glPixelStorei(GL_UNPACK_ROW_LENGTH, s->uiW);
          glPixelStorei(GL_UNPACK_SKIP_PIXELS, s->uiDx0);
          glPixelStorei(GL_UNPACK_SKIP_ROWS, s->uiDy0);
          glTexSubImage2D(GL_TEXTURE_2D, 0, s->uiDx0, s->uiDy0, s->uiDx1 - s->uiDx0,
                          s->uiDy1 - s->uiDy0, GL_RGBA, GL_UNSIGNED_BYTE, s->uiPending.data());
          glPixelStorei(GL_UNPACK_ROW_LENGTH, 0);
          glPixelStorei(GL_UNPACK_SKIP_PIXELS, 0);
          glPixelStorei(GL_UNPACK_SKIP_ROWS, 0);
        }
        s->uiDirty = false;
      }
    }

    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glViewport(0, 0, w, h);
    glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    glViewport(0, 0, w, pageH);
    glDisable(GL_BLEND);
    DrawTex(s, s->videoTex, /*flipY=*/1.0f, /*bgra=*/0);  // mpv render-API FBO is top-down
    if (s->uiW > 0) {
      glEnable(GL_BLEND);
      glBlendFuncSeparate(GL_ONE, GL_ONE_MINUS_SRC_ALPHA, GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
      DrawTex(s, s->uiTex, /*flipY=*/1.0f, /*bgra=*/1);
      glDisable(GL_BLEND);
    }
    if (barPx > 0) {
      glViewport(0, pageH, w, barPx);
      DrawChrome(s, w, h, zoom, barPx, 0, hover, pressed, c.maximized);
    }
    // Sets the alpha of every pixel: the page leaves it below 1 wherever it is see-through.
    glViewport(0, 0, w, h);
    glEnable(GL_BLEND);
    glBlendFuncSeparate(GL_ZERO, GL_SRC_ALPHA, GL_ONE, GL_ZERO);
    const bool square = c.maximized || c.fullscreen;
    DrawChrome(s, w, h, zoom, 0, square ? 0 : kCornerRadius * zoom, -1, -1, false);
    glDisable(GL_BLEND);
    SDL_GL_SwapWindow(s->window);
    if (s->mpvGl) M::rc_report_swap(s->mpvGl);
  }

  if (s->mpvGl) {
    M::rc_free(s->mpvGl);  // free render context ON the render thread
    s->mpvGl = nullptr;
  }
  SDL_GL_DestroyContext(s->gl);
  SDL_DestroyWindow(s->window);
  SDL_Quit();
  s->gl = nullptr;
  s->window = nullptr;
}

void Emit(const std::string& json) {
  if (g_tsfnReady.load()) g_tsfn.BlockingCall(new std::string(json));
}

// The seekbar position is read here, off the Electron main thread, at ~4 Hz while playing.
void EventThreadMain(GlState* s) {
  using clock = std::chrono::steady_clock;
  auto lastEmit = clock::now() - std::chrono::seconds(1);
  const auto kEmitInterval = std::chrono::milliseconds(250);

  auto emitPosition = [&](bool force) {
    if (!s->run.load(std::memory_order_acquire)) return;
    const auto now = clock::now();
    if (!force && now - lastEmit < kEmitInterval) return;
    lastEmit = now;
    // No position during a load/seek gap: hold the last value rather than collapse the bar to 0.
    char* tp = M::get_property_string(s->mpv, "time-pos");
    if (!tp) return;
    char* cache = M::get_property_string(s->mpv, "demuxer-cache-time");
    char pb[32], db[32], bb[32];
    snprintf(pb, sizeof(pb), "%.3f", atof(tp));
    snprintf(db, sizeof(db), "%.3f", s->duration);
    snprintf(bb, sizeof(bb), "%.3f", cache ? atof(cache) : 0.0);
    M::mpv_free(tp);
    if (cache) M::mpv_free(cache);
    Emit(std::string("{\"type\":\"timeUpdate\",\"position\":") + pb + ",\"duration\":" + db +
         ",\"buffered\":" + bb + "}");
  };

  while (s->run.load(std::memory_order_acquire)) {
    mpv_event* ev = M::wait_event(s->mpv, 0.1);
    if (ev && ev->event_id != MPV_EVENT_NONE) {
      switch (ev->event_id) {
        case MPV_EVENT_PROPERTY_CHANGE: {
          auto* p = static_cast<mpv_event_property*>(ev->data);
          if (!p) break;
          // track-list is observed with MPV_FORMAT_NONE: no data to guard on.
          if (std::strcmp(p->name, "track-list") == 0) {
            Emit("{\"type\":\"tracksChanged\"}");
            break;
          }
          if (!p->data) break;
          if (std::strcmp(p->name, "duration") == 0 && p->format == MPV_FORMAT_DOUBLE) {
            s->duration = *static_cast<double*>(p->data);
          } else if (std::strcmp(p->name, "pause") == 0 && p->format == MPV_FORMAT_FLAG) {
            int paused = *static_cast<int*>(p->data);
            s->paused.store(paused != 0);
            Emit(std::string("{\"type\":\"stateChanged\",\"state\":\"") +
                 (paused ? "paused" : "playing") + "\"}");
          }
          break;
        }
        case MPV_EVENT_LOG_MESSAGE: {
          auto* m = static_cast<mpv_event_log_message*>(ev->data);
          if (m) fprintf(stderr, "[mpv] %s: %s", m->prefix, m->text);
          break;
        }
        case MPV_EVENT_PLAYBACK_RESTART:
          emitPosition(true);
          Emit("{\"type\":\"firstFrame\"}");
          break;
        case MPV_EVENT_END_FILE: {
          auto* e = static_cast<mpv_event_end_file*>(ev->data);
          if (e && e->reason == MPV_END_FILE_REASON_EOF)
            Emit("{\"type\":\"stateChanged\",\"state\":\"ended\"}");
          else if (e && e->reason == MPV_END_FILE_REASON_ERROR)
            Emit("{\"type\":\"error\",\"message\":\"end-file error\"}");
          break;
        }
        case MPV_EVENT_COMMAND_REPLY:
          if (ev->error < 0)
            fprintf(stderr, "[compositor] async command failed: %s\n", M::error_string(ev->error));
          break;
        default:
          break;
      }
    }
    if (!s->paused.load()) emitPosition(false);
  }
}

// ── N-API surface ────────────────────────────────────────────────────────────

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_state.run.load()) return env.Undefined();
  if (info.Length() > 0 && info[0].IsObject()) {
    Napi::Object o = info[0].As<Napi::Object>();
    if (o.Has("width")) g_state.width = o.Get("width").As<Napi::Number>().Int32Value();
    if (o.Has("height")) g_state.height = o.Get("height").As<Napi::Number>().Int32Value();
    if (o.Has("title")) g_state.title = o.Get("title").As<Napi::String>().Utf8Value();
    if (o.Has("icon") && o.Get("icon").IsString())
      g_state.iconPath = o.Get("icon").As<Napi::String>().Utf8Value();
  }
  if (!M::Load()) {
    Napi::Error::New(env, "libmpv load failed").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  g_state.mpv = M::create();
  if (g_state.mpv) {
    M::set_option_string(g_state.mpv, "vo", "libmpv");
    M::set_option_string(g_state.mpv, "hwdec", getenv("FLIKS_HWDEC") ? getenv("FLIKS_HWDEC") : "no");
    M::set_option_string(g_state.mpv, "ytdl", "no");
    M::set_option_string(g_state.mpv, "terminal", "no");
    M::set_option_string(g_state.mpv, "load-unsafe-playlists", "yes");
    // Streaming/buffering/reconnect tuning is applied from TS after start
    // (MPV_STREAM_OPTIONS in src/shared/mpv-stream-options.ts) — one source of
    // truth shared with the Windows subprocess + macOS backends.
    if (M::initialize(g_state.mpv) < 0) fprintf(stderr, "[compositor] mpv_initialize failed\n");
    M::observe_property(g_state.mpv, 2, "duration", MPV_FORMAT_DOUBLE);
    M::observe_property(g_state.mpv, 3, "pause", MPV_FORMAT_FLAG);
    M::observe_property(g_state.mpv, 4, "track-list", MPV_FORMAT_NONE);
    // Default to verbose so the ffmpeg HLS demuxer logs every segment URL it
    // opens and the HTTP status it gets back (diagnosing transcode/seg-0
    // failures). Override with FLIKS_MPV_LOGLEVEL (warn / info / v / debug).
    M::request_log_messages(g_state.mpv, getenv("FLIKS_MPV_LOGLEVEL") ? getenv("FLIKS_MPV_LOGLEVEL") : "v");
    fprintf(stderr, "[compositor] mpv ready (hwdec=%s)\n",
            getenv("FLIKS_HWDEC") ? getenv("FLIKS_HWDEC") : "no");
  }
  g_state.run.store(true);
  g_state.renderThread = std::thread(RenderThreadMain, &g_state);
  g_state.eventThread = std::thread(EventThreadMain, &g_state);
  return env.Undefined();
}

// onEvent(cb): register the JS callback that receives event JSON strings.
Napi::Value OnEvent(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) return env.Undefined();
  g_tsfn = EventTSFN::New(env, info[0].As<Napi::Function>(), "fliksMpvEvents", 0, 1);
  g_tsfnReady.store(true);
  return env.Undefined();
}

// onInput(cb): register the JS callback that receives SDL input JSON strings.
Napi::Value OnInput(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) return env.Undefined();
  g_inputTsfn = EventTSFN::New(env, info[0].As<Napi::Function>(), "fliksInput", 0, 1);
  g_inputReady.store(true);
  return env.Undefined();
}

// load({url, fileOptions?, headers?, subtitles?})
Napi::Value Load(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_state.mpv || info.Length() < 1 || !info[0].IsObject()) return env.Undefined();
  Napi::Object o = info[0].As<Napi::Object>();
  std::string url = o.Get("url").As<Napi::String>().Utf8Value();
  std::vector<std::string> opts;
  // Per-file mpv options built in TS (src/main/mpv/load-options.ts), the same for every backend.
  if (o.Has("fileOptions") && o.Get("fileOptions").IsArray()) {
    Napi::Array fo = o.Get("fileOptions").As<Napi::Array>();
    for (uint32_t i = 0; i < fo.Length(); i++) opts.push_back(fo.Get(i).ToString().Utf8Value());
  }
  if (o.Has("headers") && o.Get("headers").IsObject()) {
    Napi::Object h = o.Get("headers").As<Napi::Object>();
    Napi::Array keys = h.GetPropertyNames();
    std::string fields;
    for (uint32_t i = 0; i < keys.Length(); i++) {
      std::string k = keys.Get(i).ToString().Utf8Value();
      std::string v = h.Get(k).ToString().Utf8Value();
      if (!fields.empty()) fields += ",";
      fields += k + ": " + v;
    }
    if (!fields.empty()) opts.push_back("http-header-fields=" + fields);
  }
  std::string optstr;
  for (size_t i = 0; i < opts.size(); i++) {
    if (i) optstr += ",";
    optstr += opts[i];
  }
  if (optstr.empty()) {
    const char* cmd[] = {"loadfile", url.c_str(), nullptr};
    M::command_async(g_state.mpv, 0, cmd);
  } else {
    // mpv 0.39+ loadfile signature: <url> <flags> <index> <options>.
    // index -1 = default (ignored for "replace"); options is the 4th arg.
    const char* cmd[] = {"loadfile", url.c_str(), "replace", "-1", optstr.c_str(), nullptr};
    M::command_async(g_state.mpv, 0, cmd);
  }
  // The persistent mpv keeps its pause state across loads: set it per load. The JS side
  // never calls play() after an autoplay load, like the mobile native player.
  {
    const bool startPaused = o.Has("startPaused") && o.Get("startPaused").ToBoolean().Value();
    const char* pause[] = {"set", "pause", startPaused ? "yes" : "no", nullptr};
    M::command_async(g_state.mpv, 0, pause);
  }
  // sidecar subtitles
  if (o.Has("subtitles") && o.Get("subtitles").IsArray()) {
    Napi::Array subs = o.Get("subtitles").As<Napi::Array>();
    for (uint32_t i = 0; i < subs.Length(); i++) {
      Napi::Object su = subs.Get(i).As<Napi::Object>();
      std::string surl = su.Get("url").ToString().Utf8Value();
      std::string lang = su.Has("language") ? su.Get("language").ToString().Utf8Value() : "";
      const char* sc[] = {"sub-add", surl.c_str(), "auto", "", lang.c_str(), nullptr};
      M::command_async(g_state.mpv, 0, sc);
    }
  }
  return env.Undefined();
}

Napi::Value Command(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_state.mpv || info.Length() < 1 || !info[0].IsArray()) return env.Undefined();
  Napi::Array arr = info[0].As<Napi::Array>();
  std::vector<std::string> parts;
  for (uint32_t i = 0; i < arr.Length(); i++) parts.push_back(arr.Get(i).ToString().Utf8Value());
  std::vector<const char*> argv;
  for (auto& p : parts) argv.push_back(p.c_str());
  argv.push_back(nullptr);
  M::command_async(g_state.mpv, 0, argv.data());
  return env.Undefined();
}

// getProperty(name) → string (mpv formats track-list etc. as JSON)
Napi::Value GetProperty(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_state.mpv || info.Length() < 1) return env.Null();
  std::string name = info[0].As<Napi::String>().Utf8Value();
  char* v = M::get_property_string(g_state.mpv, name.c_str());
  if (!v) return env.Null();
  Napi::Value r = Napi::String::New(env, v);
  M::mpv_free(v);
  return r;
}

Napi::Value SetProperty(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_state.mpv || info.Length() < 2) return env.Undefined();
  std::string name = info[0].As<Napi::String>().Utf8Value();
  std::string val = info[1].ToString().Utf8Value();
  const char* argv[] = {"set", name.c_str(), val.c_str(), nullptr};
  M::command_async(g_state.mpv, 0, argv);
  return env.Undefined();
}

Napi::Value SetFullscreen(const Napi::CallbackInfo& info) {
  bool on = info.Length() > 0 && info[0].ToBoolean().Value();
  g_state.fsRequest.store(on ? 1 : 0, std::memory_order_release);
  return info.Env().Undefined();
}

Napi::Value SetCursorShape(const Napi::CallbackInfo& info) {
  int shape = info.Length() > 0 ? info[0].ToNumber().Int32Value() : 0;
  g_state.cursorShape.store(shape, std::memory_order_release);
  return info.Env().Undefined();
}

Napi::Value SetCursorVisible(const Napi::CallbackInfo& info) {
  bool on = info.Length() > 0 && info[0].ToBoolean().Value();
  g_state.cursorRequest.store(on ? 1 : 0, std::memory_order_release);
  return info.Env().Undefined();
}

// uploadUi(rectPixels, frameW, frameH, x, y, w, h): the dirty rect of a frameW x frameH bitmap.
Napi::Value UploadUi(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 7 || !info[0].IsBuffer()) return env.Undefined();
  auto buf = info[0].As<Napi::Buffer<uint8_t>>();
  int fw = info[1].As<Napi::Number>().Int32Value();
  int fh = info[2].As<Napi::Number>().Int32Value();
  int x = info[3].As<Napi::Number>().Int32Value();
  int y = info[4].As<Napi::Number>().Int32Value();
  int w = info[5].As<Napi::Number>().Int32Value();
  int h = info[6].As<Napi::Number>().Int32Value();
  if (fw <= 0 || fh <= 0 || w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > fw || y + h > fh)
    return env.Undefined();
  if (buf.Length() < static_cast<size_t>(w) * h * 4) return env.Undefined();
  {
    std::lock_guard<std::mutex> lk(g_state.uiMutex);
    if (fw != g_state.uiW || fh != g_state.uiH) {
      g_state.uiPending.assign(static_cast<size_t>(fw) * fh * 4, 0);
      g_state.uiW = fw;
      g_state.uiH = fh;
      g_state.uiResized = true;
      g_state.uiDirty = false;
    }
    for (int r = 0; r < h; r++)
      memcpy(g_state.uiPending.data() + (static_cast<size_t>(y + r) * fw + x) * 4,
             buf.Data() + static_cast<size_t>(r) * w * 4, static_cast<size_t>(w) * 4);
    if (g_state.uiDirty) {
      g_state.uiDx0 = std::min(g_state.uiDx0, x);
      g_state.uiDy0 = std::min(g_state.uiDy0, y);
      g_state.uiDx1 = std::max(g_state.uiDx1, x + w);
      g_state.uiDy1 = std::max(g_state.uiDy1, y + h);
    } else {
      g_state.uiDx0 = x;
      g_state.uiDy0 = y;
      g_state.uiDx1 = x + w;
      g_state.uiDy1 = y + h;
    }
    g_state.uiDirty = true;
  }
  return env.Undefined();
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  g_state.run.store(false);
  if (g_state.eventThread.joinable()) g_state.eventThread.join();
  if (g_state.renderThread.joinable()) g_state.renderThread.join();
  if (g_tsfnReady.exchange(false)) g_tsfn.Release();
  if (g_inputReady.exchange(false)) g_inputTsfn.Release();
  if (g_state.mpv) {
    M::destroy(g_state.mpv);  // mpv_terminate_destroy
    g_state.mpv = nullptr;
  }
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("onEvent", Napi::Function::New(env, OnEvent));
  exports.Set("onInput", Napi::Function::New(env, OnInput));
  exports.Set("uploadUi", Napi::Function::New(env, UploadUi));
  exports.Set("load", Napi::Function::New(env, Load));
  exports.Set("command", Napi::Function::New(env, Command));
  exports.Set("getProperty", Napi::Function::New(env, GetProperty));
  exports.Set("setProperty", Napi::Function::New(env, SetProperty));
  exports.Set("setFullscreen", Napi::Function::New(env, SetFullscreen));
  exports.Set("setCursorVisible", Napi::Function::New(env, SetCursorVisible));
  exports.Set("setCursorShape", Napi::Function::New(env, SetCursorShape));
  exports.Set("stop", Napi::Function::New(env, Stop));
  return exports;
}

}  // namespace

NODE_API_MODULE(fliks_compositor, Init)
