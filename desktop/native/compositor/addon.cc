// fliks_compositor — native single-window GL compositor (Electron+mpv, Option C).
//
// One SDL2/GLES window. mpv (self-contained libmpv, plain dlopen — FFmpeg
// statically linked + symbols hidden, so no clash with Electron's libffmpeg)
// renders video via the RENDER API into a GL FBO; the Electron OSR UI bitmap is
// uploaded to a GL texture; both are composited (video then UI, premult-alpha)
// into the window. Three threads: Node/main (N-API), render (GL ctx), and mpv
// event poll. mpv FBO + OSR UI are both top-down → flipped in-shader (mpv's
// FLIP_Y param is unsupported); UI is BGRA → swizzled.
#define _GNU_SOURCE 1
#include <napi.h>

#include <SDL.h>
#include <GLES3/gl32.h>

#include <mpv/client.h>
#include <mpv/render.h>
#include <mpv/render_gl.h>

#include <dlfcn.h>

#include <atomic>
#include <cstdio>
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
  std::atomic<bool> run{false};
  std::atomic<int> fsRequest{-1};  // -1 none, 0 windowed, 1 fullscreen-desktop
  std::thread renderThread;
  std::thread eventThread;

  GLuint program = 0;
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

  mpv_handle* mpv = nullptr;
  mpv_render_context* mpvGl = nullptr;
  double duration = 0;
};

GlState g_state;

const char* kVert = R"(#version 320 es
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

const char* kFrag = R"(#version 320 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform int u_bgra;
out vec4 frag;
void main() {
  vec4 c = texture(u_tex, v_uv);
  frag = (u_bgra == 1) ? c.bgra : c;
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
  glGenVertexArrays(1, &s->vao);
  glGenTextures(1, &s->uiTex);
  glBindTexture(GL_TEXTURE_2D, s->uiTex);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
}

void* GetProc(void*, const char* name) { return SDL_GL_GetProcAddress(name); }
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

void RenderThreadMain(GlState* s) {
  if (SDL_Init(SDL_INIT_VIDEO) != 0) {
    fprintf(stderr, "[compositor] SDL_Init failed: %s\n", SDL_GetError());
    return;
  }
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 2);
  SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1);
  s->window = SDL_CreateWindow(
      s->title.c_str(), SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, s->width,
      s->height, SDL_WINDOW_OPENGL | SDL_WINDOW_RESIZABLE | SDL_WINDOW_SHOWN);
  if (!s->window) {
    fprintf(stderr, "[compositor] SDL_CreateWindow failed: %s\n", SDL_GetError());
    SDL_Quit();
    return;
  }
  s->gl = SDL_GL_CreateContext(s->window);
  SDL_GL_MakeCurrent(s->window, s->gl);
  SDL_GL_SetSwapInterval(1);
  fprintf(stderr, "[compositor] GL %s | %s\n", glGetString(GL_VERSION), glGetString(GL_RENDERER));
  SDL_StartTextInput();
  InitGl(s);
  MpvRenderInit(s);

  auto emitInput = [](const std::string& j) {
    if (g_inputReady.load()) g_inputTsfn.BlockingCall(new std::string(j));
  };
  char ib[256];
  int lastW = -1, lastH = -1;

  while (s->run.load(std::memory_order_acquire)) {
    SDL_Event ev;
    while (SDL_PollEvent(&ev)) {
      switch (ev.type) {
        case SDL_QUIT:
          s->run.store(false);
          break;
        case SDL_MOUSEMOTION:
          snprintf(ib, sizeof(ib), "{\"kind\":\"move\",\"x\":%d,\"y\":%d}", ev.motion.x, ev.motion.y);
          emitInput(ib);
          break;
        case SDL_MOUSEBUTTONDOWN:
        case SDL_MOUSEBUTTONUP: {
          const char* btn = ev.button.button == SDL_BUTTON_RIGHT  ? "right"
                            : ev.button.button == SDL_BUTTON_MIDDLE ? "middle"
                                                                    : "left";
          snprintf(ib, sizeof(ib),
                   "{\"kind\":\"button\",\"down\":%s,\"x\":%d,\"y\":%d,\"button\":\"%s\",\"clicks\":%d}",
                   ev.type == SDL_MOUSEBUTTONDOWN ? "true" : "false", ev.button.x, ev.button.y, btn,
                   ev.button.clicks);
          emitInput(ib);
          break;
        }
        case SDL_MOUSEWHEEL: {
          int mx, my;
          SDL_GetMouseState(&mx, &my);
          snprintf(ib, sizeof(ib), "{\"kind\":\"wheel\",\"x\":%d,\"y\":%d,\"dx\":%d,\"dy\":%d}", mx,
                   my, ev.wheel.x, ev.wheel.y);
          emitInput(ib);
          break;
        }
        case SDL_KEYDOWN:
        case SDL_KEYUP: {
          snprintf(ib, sizeof(ib), "{\"kind\":\"key\",\"down\":%s,\"key\":\"%s\"}",
                   ev.type == SDL_KEYDOWN ? "true" : "false", SDL_GetKeyName(ev.key.keysym.sym));
          emitInput(ib);
          break;
        }
        case SDL_TEXTINPUT: {
          // escape the text minimally for JSON
          std::string t = ev.text.text;
          std::string esc;
          for (char c : t) {
            if (c == '"' || c == '\\') esc += '\\';
            esc += c;
          }
          emitInput("{\"kind\":\"text\",\"text\":\"" + esc + "\"}");
          break;
        }
        default:
          break;
      }
    }
    int fs = s->fsRequest.exchange(-1, std::memory_order_acq_rel);
    if (fs >= 0)
      SDL_SetWindowFullscreen(s->window, fs == 1 ? SDL_WINDOW_FULLSCREEN_DESKTOP : 0);

    int w, h;
    SDL_GL_GetDrawableSize(s->window, &w, &h);
    if (w != lastW || h != lastH) {
      lastW = w;
      lastH = h;
      snprintf(ib, sizeof(ib), "{\"kind\":\"resize\",\"w\":%d,\"h\":%d}", w, h);
      emitInput(ib);
    }
    EnsureVideoFbo(s, w, h);

    if (s->mpvGl) {
      uint64_t flags = M::rc_update(s->mpvGl);
      if (flags & MPV_RENDER_UPDATE_FRAME) {
        mpv_opengl_fbo fbo{static_cast<int>(s->videoFbo), w, h, 0};
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
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, s->uiW, s->uiH, 0, GL_RGBA,
                     GL_UNSIGNED_BYTE, s->uiPending.data());
        s->uiDirty = false;
      }
    }

    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glViewport(0, 0, w, h);
    glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    glDisable(GL_BLEND);
    DrawTex(s, s->videoTex, /*flipY=*/1.0f, /*bgra=*/0);  // mpv render-API FBO is top-down
    if (s->uiW > 0) {
      glEnable(GL_BLEND);
      glBlendFuncSeparate(GL_ONE, GL_ONE_MINUS_SRC_ALPHA, GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
      DrawTex(s, s->uiTex, /*flipY=*/1.0f, /*bgra=*/1);
      glDisable(GL_BLEND);
    }
    SDL_GL_SwapWindow(s->window);
    if (s->mpvGl) M::rc_report_swap(s->mpvGl);
  }

  if (s->mpvGl) {
    M::rc_free(s->mpvGl);  // free render context ON the render thread
    s->mpvGl = nullptr;
  }
  SDL_GL_DeleteContext(s->gl);
  SDL_DestroyWindow(s->window);
  SDL_Quit();
  s->gl = nullptr;
  s->window = nullptr;
}

void Emit(const std::string& json) {
  if (g_tsfnReady.load()) g_tsfn.BlockingCall(new std::string(json));
}

void EventThreadMain(GlState* s) {
  char buf[64];
  while (s->run.load(std::memory_order_acquire)) {
    mpv_event* ev = M::wait_event(s->mpv, 0.1);
    if (!ev || ev->event_id == MPV_EVENT_NONE) continue;
    switch (ev->event_id) {
      case MPV_EVENT_PROPERTY_CHANGE: {
        auto* p = static_cast<mpv_event_property*>(ev->data);
        if (!p) break;
        // track-list is observed with MPV_FORMAT_NONE, so its change event
        // carries no data — handle it before the data guard the value-bearing
        // properties need.
        if (std::strcmp(p->name, "track-list") == 0) {
          Emit("{\"type\":\"tracksChanged\"}");
          break;
        }
        if (!p->data) break;
        if (std::strcmp(p->name, "time-pos") == 0 && p->format == MPV_FORMAT_DOUBLE) {
          double t = *static_cast<double*>(p->data);
          snprintf(buf, sizeof(buf), "%.3f", t);
          std::string d;
          snprintf(buf, sizeof(buf), "%.3f", s->duration);
          d = buf;
          char pb[32];
          snprintf(pb, sizeof(pb), "%.3f", t);
          Emit(std::string("{\"type\":\"timeUpdate\",\"position\":") + pb +
               ",\"duration\":" + d + "}");
        } else if (std::strcmp(p->name, "duration") == 0 && p->format == MPV_FORMAT_DOUBLE) {
          s->duration = *static_cast<double*>(p->data);
        } else if (std::strcmp(p->name, "pause") == 0 && p->format == MPV_FORMAT_FLAG) {
          int paused = *static_cast<int*>(p->data);
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
      default:
        break;
    }
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
    // The backend produces transcode segments on demand: it answers 404 (seg-0/
    // init on a resume, before the early companion writes them) or 503 (the
    // resume segment while ffmpeg is still encoding it). Shaka/ExoPlayer retry
    // and recover — mpv's ffmpeg HLS demuxer aborts/skips on the first error.
    // Make its child segment/init opens reconnect on BOTH 4xx and 5xx with
    // backoff so a transient miss doesn't kill the load or skip the resume
    // segment. The `4xx,5xx` value carries a comma, so it uses mpv's `%len%`
    // escaping (7 = strlen("4xx,5xx")) to survive the key-value-list parser.
    M::set_option_string(g_state.mpv, "demuxer-lavf-o",
        "reconnect=1,reconnect_streamed=1,reconnect_on_http_error=%7%4xx,5xx,reconnect_delay_max=30");
    if (M::initialize(g_state.mpv) < 0) fprintf(stderr, "[compositor] mpv_initialize failed\n");
    M::observe_property(g_state.mpv, 1, "time-pos", MPV_FORMAT_DOUBLE);
    M::observe_property(g_state.mpv, 2, "duration", MPV_FORMAT_DOUBLE);
    M::observe_property(g_state.mpv, 3, "pause", MPV_FORMAT_FLAG);
    M::observe_property(g_state.mpv, 4, "track-list", MPV_FORMAT_NONE);
    // Default to verbose so the ffmpeg HLS demuxer logs every segment URL it
    // opens and the HTTP status it gets back (diagnosing transcode/seg-0
    // failures). Override with FLIKS_MPV_LOGLEVEL (warn / info / v / debug).
    M::request_log_messages(g_state.mpv, getenv("FLIKS_MPV_LOGLEVEL") ? getenv("FLIKS_MPV_LOGLEVEL") : "v");
    fprintf(stderr, "[compositor] mpv ready (hwdec=auto-copy)\n");
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

// load({url, startTime?, headers?, subtitles?})
Napi::Value Load(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_state.mpv || info.Length() < 1 || !info[0].IsObject()) return env.Undefined();
  Napi::Object o = info[0].As<Napi::Object>();
  std::string url = o.Get("url").As<Napi::String>().Utf8Value();
  std::vector<std::string> opts;
  if (o.Has("startTime") && o.Get("startTime").IsNumber()) {
    double t = o.Get("startTime").As<Napi::Number>().DoubleValue();
    if (t > 0) {
      char b[48];
      snprintf(b, sizeof(b), "start=+%.3f", t);
      opts.emplace_back(b);
    }
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
    M::command(g_state.mpv, cmd);
  } else {
    // mpv 0.39+ loadfile signature: <url> <flags> <index> <options>.
    // index -1 = default (ignored for "replace"); options is the 4th arg.
    const char* cmd[] = {"loadfile", url.c_str(), "replace", "-1", optstr.c_str(), nullptr};
    M::command(g_state.mpv, cmd);
  }
  // The persistent mpv keeps its pause state across loads; force playback so a
  // freshly opened file always autoplays. The JS side treats this engine like
  // the mobile native player (playWhenReady) and never calls play() itself.
  M::set_property_string(g_state.mpv, "pause", "no");
  // sidecar subtitles
  if (o.Has("subtitles") && o.Get("subtitles").IsArray()) {
    Napi::Array subs = o.Get("subtitles").As<Napi::Array>();
    for (uint32_t i = 0; i < subs.Length(); i++) {
      Napi::Object su = subs.Get(i).As<Napi::Object>();
      std::string surl = su.Get("url").ToString().Utf8Value();
      std::string lang = su.Has("language") ? su.Get("language").ToString().Utf8Value() : "";
      const char* sc[] = {"sub-add", surl.c_str(), "auto", "", lang.c_str(), nullptr};
      M::command(g_state.mpv, sc);
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
  M::command(g_state.mpv, argv.data());
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
  int rc = M::set_property_string(g_state.mpv, name.c_str(), val.c_str());
  if (rc < 0)
    fprintf(stderr, "[compositor] set_property %s=%s failed (%d)\n", name.c_str(), val.c_str(), rc);
  return env.Undefined();
}

Napi::Value SetFullscreen(const Napi::CallbackInfo& info) {
  bool on = info.Length() > 0 && info[0].ToBoolean().Value();
  g_state.fsRequest.store(on ? 1 : 0, std::memory_order_release);
  return info.Env().Undefined();
}

Napi::Value UploadUi(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsBuffer()) return env.Undefined();
  auto buf = info[0].As<Napi::Buffer<uint8_t>>();
  int w = info[1].As<Napi::Number>().Int32Value();
  int h = info[2].As<Napi::Number>().Int32Value();
  size_t need = static_cast<size_t>(w) * h * 4;
  if (buf.Length() < need) return env.Undefined();
  {
    std::lock_guard<std::mutex> lk(g_state.uiMutex);
    g_state.uiPending.assign(buf.Data(), buf.Data() + need);
    g_state.uiW = w;
    g_state.uiH = h;
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
  exports.Set("stop", Napi::Function::New(env, Stop));
  return exports;
}

}  // namespace

NODE_API_MODULE(fliks_compositor, Init)
