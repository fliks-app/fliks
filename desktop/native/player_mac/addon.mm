// fliks_player_mac — in-process libmpv embed for macOS.
//
// Unlike Linux (a self-compositing SDL/GLES window) and Windows (an mpv
// SUBPROCESS embedded via --wid), macOS embeds libmpv IN-PROCESS: mpv's
// subprocess --wid crashes there ("--wid works only with libmpv"), and the
// macOS window server already composites sibling windows correctly, so no
// self-compositor is needed.
//
// The Electron videoWin's content NSView (getNativeWindowHandle) hosts a
// CAOpenGLLayer; mpv renders into that layer's framebuffer via the RENDER API
// (vo=libmpv, MPV_RENDER_API_TYPE_OPENGL). The layer drives its own CVDisplayLink
// (asynchronous=YES), so rendering happens off the main thread while AppKit/Core
// Animation tree mutation stays on main (where N-API calls land). The sibling
// uiWin (a real Electron window owned by videoWin) draws the controls above it.
//
// libmpv is dlopen'd (self-contained build: FFmpeg static + symbols hidden, so
// no clash with Electron's bundled libffmpeg.dylib) — mirrors the Linux addon.
// Control plane (commands/properties/observe/events) is lifted from
// native/compositor/addon.cc; the SDL/GLES compositor + OSR-UI upload are not.

#define GL_SILENCE_DEPRECATION 1

#include <napi.h>

#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <OpenGL/OpenGL.h>
#import <OpenGL/gl3.h>
#import <CoreFoundation/CoreFoundation.h>

#include <mpv/client.h>
#include <mpv/render.h>
#include <mpv/render_gl.h>

#include <dlfcn.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

// ── dlopen'd self-contained libmpv (identical surface to the Linux addon) ─────
namespace M {
mpv_handle* (*create)(void) = nullptr;
int (*set_option_string)(mpv_handle*, const char*, const char*) = nullptr;
int (*set_property_string)(mpv_handle*, const char*, const char*) = nullptr;
char* (*get_property_string)(mpv_handle*, const char*) = nullptr;
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
  if (!path) path = "libmpv.dylib";
  void* h = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (!h) {
    fprintf(stderr, "[player-mac] dlopen libmpv failed: %s\n", dlerror());
    return false;
  }
  fprintf(stderr, "[player-mac] libmpv loaded: %s\n", path);
#define SYM(field, name)                                     \
  field = reinterpret_cast<decltype(field)>(dlsym(h, name)); \
  if (!field) { fprintf(stderr, "[player-mac] missing %s\n", name); return false; }
  SYM(create, "mpv_create")
  SYM(set_option_string, "mpv_set_option_string")
  SYM(set_property_string, "mpv_set_property_string")
  SYM(get_property_string, "mpv_get_property_string")
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

// ── thread-safe event marshalling to JS (lifted from addon.cc) ───────────────
void CallJs(Napi::Env env, Napi::Function cb, void*, std::string* data) {
  if (env != nullptr && cb != nullptr) cb.Call({Napi::String::New(env, *data)});
  delete data;
}
using EventTSFN = Napi::TypedThreadSafeFunction<void, std::string, CallJs>;
EventTSFN g_tsfn;
std::atomic<bool> g_tsfnReady{false};

struct State {
  mpv_handle* mpv = nullptr;
  mpv_render_context* mpvGl = nullptr;
  CGLContextObj cgl = nullptr;  // the layer's GL context, captured for teardown
  std::mutex renderMutex;       // guards rc_render vs rc_free
  std::atomic<bool> run{false};
  std::atomic<bool> dirty{true};  // force a redraw (resize / first paint)
  std::thread eventThread;
  double duration = 0;
};

State g_state;

// CGL proc loader for mpv's OpenGL render backend.
void* GetProcGL(void*, const char* name) {
  static CFBundleRef bundle = CFBundleGetBundleWithIdentifier(CFSTR("com.apple.opengl"));
  if (!bundle) return nullptr;
  CFStringRef s = CFStringCreateWithCString(kCFAllocatorDefault, name, kCFStringEncodingASCII);
  void* p = CFBundleGetFunctionPointerForName(bundle, s);
  CFRelease(s);
  return p;
}

void OnMpvUpdate(void*) { /* asynchronous CAOpenGLLayer polls rc_update at vsync */ }

void Emit(const std::string& json) {
  if (g_tsfnReady.load()) g_tsfn.BlockingCall(new std::string(json));
}

}  // namespace

// ── the GL layer mpv renders into ────────────────────────────────────────────
@interface MpvGLLayer : CAOpenGLLayer
@end

@implementation MpvGLLayer

- (CGLPixelFormatObj)copyCGLPixelFormatForDisplayMask:(uint32_t)mask {
  // Prefer a half-float (RGBA16F) backing so HDR/EDR content can pass through
  // (paired with wantsExtendedDynamicRangeContent + an HDR layer colorspace).
  // Fall back to a plain 8-bit format (SDR) where float isn't available.
  CGLPixelFormatAttribute hdr[] = {
      kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core,
      kCGLPFAColorFloat,
      kCGLPFAColorSize, (CGLPixelFormatAttribute)64,
      kCGLPFADoubleBuffer,
      kCGLPFAAccelerated,
      kCGLPFAAllowOfflineRenderers,
      (CGLPixelFormatAttribute)0,
  };
  CGLPixelFormatAttribute sdr[] = {
      kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core,
      kCGLPFADoubleBuffer,
      kCGLPFAAccelerated,
      kCGLPFAAllowOfflineRenderers,
      (CGLPixelFormatAttribute)0,
  };
  const char* forceSdr = getenv("FLIKS_HDR");
  bool wantHdr = !(forceSdr && std::strcmp(forceSdr, "no") == 0);
  CGLPixelFormatObj pf = nullptr;
  GLint n = 0;
  if (wantHdr && CGLChoosePixelFormat(hdr, &pf, &n) == kCGLNoError && pf) {
    fprintf(stderr, "[player-mac] GL pixel format: RGBA16F (HDR-capable)\n");
    return pf;
  }
  if (CGLChoosePixelFormat(sdr, &pf, &n) == kCGLNoError && pf) {
    fprintf(stderr, "[player-mac] GL pixel format: 8-bit (SDR)\n");
    return pf;
  }
  return [super copyCGLPixelFormatForDisplayMask:mask];
}

- (BOOL)canDrawInCGLContext:(CGLContextObj)ctx
                pixelFormat:(CGLPixelFormatObj)pf
               forLayerTime:(CFTimeInterval)t
                displayTime:(const CVTimeStamp*)ts {
  if (!g_state.run.load()) return NO;
  if (!g_state.mpvGl) return YES;  // first draw creates the render context
  if (g_state.dirty.load()) return YES;
  uint64_t flags = M::rc_update(g_state.mpvGl);
  return (flags & MPV_RENDER_UPDATE_FRAME) ? YES : NO;
}

- (void)drawInCGLContext:(CGLContextObj)ctx
             pixelFormat:(CGLPixelFormatObj)pf
            forLayerTime:(CFTimeInterval)t
             displayTime:(const CVTimeStamp*)ts {
  std::lock_guard<std::mutex> lk(g_state.renderMutex);
  if (!g_state.run.load() || !g_state.mpv) return;
  g_state.cgl = ctx;  // capture for teardown (rc_free needs a current context)

  if (!g_state.mpvGl) {
    mpv_opengl_init_params gl_init{};
    gl_init.get_proc_address = GetProcGL;
    gl_init.get_proc_address_ctx = nullptr;
    int advanced = 1;
    mpv_render_param params[] = {
        {MPV_RENDER_PARAM_API_TYPE, const_cast<char*>(MPV_RENDER_API_TYPE_OPENGL)},
        {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl_init},
        {MPV_RENDER_PARAM_ADVANCED_CONTROL, &advanced},
        {static_cast<mpv_render_param_type>(0), nullptr},
    };
    int rc = M::rc_create(&g_state.mpvGl, g_state.mpv, params);
    if (rc < 0) {
      fprintf(stderr, "[player-mac] rc_create failed: %s\n", M::error_string(rc));
      return;
    }
    M::rc_set_update_callback(g_state.mpvGl, OnMpvUpdate, &g_state);
    fprintf(stderr, "[player-mac] mpv render context ready\n");
  }

  g_state.dirty.store(false);
  GLint fbo = 0;
  glGetIntegerv(GL_FRAMEBUFFER_BINDING, &fbo);
  CGFloat scale = self.contentsScale;
  int w = static_cast<int>(self.bounds.size.width * scale);
  int h = static_cast<int>(self.bounds.size.height * scale);
  if (w <= 0 || h <= 0) return;

  mpv_opengl_fbo mfbo{static_cast<int>(fbo), w, h, 0};
  // The CAOpenGLLayer framebuffer is bottom-up (GL convention); mpv's render-API
  // output is top-down, so flip vertically to present upright.
  int flip = 1;
  mpv_render_param rp[] = {
      {MPV_RENDER_PARAM_OPENGL_FBO, &mfbo},
      {MPV_RENDER_PARAM_FLIP_Y, &flip},
      {static_cast<mpv_render_param_type>(0), nullptr},
  };
  M::rc_render(g_state.mpvGl, rp);
  [super drawInCGLContext:ctx pixelFormat:pf forLayerTime:t displayTime:ts];
  M::rc_report_swap(g_state.mpvGl);
}

@end

namespace {

MpvGLLayer* g_layer = nil;
NSView* g_view = nil;  // not owned (Electron's content view)
id g_backingObserver = nil;
id g_frameObserver = nil;

void UpdateLayerGeometry() {
  if (!g_layer || !g_view) return;
  NSWindow* win = g_view.window;
  CGFloat scale = win ? win.backingScaleFactor : 2.0;
  g_layer.contentsScale = scale;
  g_layer.frame = g_view.bounds;
  g_state.dirty.store(true);
  [g_layer setNeedsDisplay];
}

// Configure the layer for HDR/EDR passthrough (best effort). The display + media
// decide whether HDR is actually used; SDR content simply renders unaffected.
void ConfigureHdr(MpvGLLayer* layer) {
  const char* forceSdr = getenv("FLIKS_HDR");
  if (forceSdr && std::strcmp(forceSdr, "no") == 0) return;
  if (@available(macOS 10.15, *)) {
    layer.wantsExtendedDynamicRangeContent = YES;
    CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceExtendedLinearDisplayP3);
    if (cs) {
      layer.colorspace = cs;
      CGColorSpaceRelease(cs);
    }
  }
}

// ── mpv event loop → JS (lifted from addon.cc EventThreadMain) ───────────────
void EventThreadMain(State* s) {
  char buf[64];
  while (s->run.load(std::memory_order_acquire)) {
    mpv_event* ev = M::wait_event(s->mpv, 0.1);
    if (!ev || ev->event_id == MPV_EVENT_NONE) continue;
    switch (ev->event_id) {
      case MPV_EVENT_PROPERTY_CHANGE: {
        auto* p = static_cast<mpv_event_property*>(ev->data);
        if (!p) break;
        if (std::strcmp(p->name, "track-list") == 0) {
          Emit("{\"type\":\"tracksChanged\"}");
          break;
        }
        if (!p->data) break;
        if (std::strcmp(p->name, "time-pos") == 0 && p->format == MPV_FORMAT_DOUBLE) {
          double t = *static_cast<double*>(p->data);
          char db[32], pb[32];
          snprintf(db, sizeof(db), "%.3f", s->duration);
          snprintf(pb, sizeof(pb), "%.3f", t);
          Emit(std::string("{\"type\":\"timeUpdate\",\"position\":") + pb +
               ",\"duration\":" + db + "}");
        } else if (std::strcmp(p->name, "duration") == 0 && p->format == MPV_FORMAT_DOUBLE) {
          s->duration = *static_cast<double*>(p->data);
        } else if (std::strcmp(p->name, "pause") == 0 && p->format == MPV_FORMAT_FLAG) {
          int paused = *static_cast<int*>(p->data);
          Emit(std::string("{\"type\":\"stateChanged\",\"state\":\"") +
               (paused ? "paused" : "playing") + "\"}");
        } else if (std::strcmp(p->name, "paused-for-cache") == 0 && p->format == MPV_FORMAT_FLAG) {
          if (*static_cast<int*>(p->data))
            Emit("{\"type\":\"stateChanged\",\"state\":\"buffering\"}");
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
    (void)buf;
  }
}

// ── N-API surface ────────────────────────────────────────────────────────────

// start({ wid: string(decimal NSView pointer), scale?: number })
Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_state.run.load()) return env.Undefined();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::Error::New(env, "start requires { wid }").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Object o = info[0].As<Napi::Object>();
  std::string widStr = o.Has("wid") ? o.Get("wid").ToString().Utf8Value() : "0";
  uintptr_t ptr = static_cast<uintptr_t>(strtoull(widStr.c_str(), nullptr, 10));
  g_view = (__bridge NSView*)reinterpret_cast<void*>(ptr);
  if (!g_view) {
    Napi::Error::New(env, "invalid NSView handle").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (!M::Load()) {
    Napi::Error::New(env, "libmpv load failed").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  g_state.mpv = M::create();
  if (!g_state.mpv) {
    Napi::Error::New(env, "mpv_create failed").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  M::set_option_string(g_state.mpv, "vo", "libmpv");
  M::set_option_string(g_state.mpv, "hwdec",
      getenv("FLIKS_HWDEC") ? getenv("FLIKS_HWDEC") : "videotoolbox");
  M::set_option_string(g_state.mpv, "ytdl", "no");
  M::set_option_string(g_state.mpv, "terminal", "no");
  M::set_option_string(g_state.mpv, "load-unsafe-playlists", "yes");
  // The app drives subtitle selection; don't let mpv auto-pick a track.
  M::set_option_string(g_state.mpv, "sid", "no");
  // Let mpv adapt its output to the layer's (HDR-capable) colorspace instead of
  // hard-tonemapping to SDR — best-effort HDR passthrough.
  M::set_option_string(g_state.mpv, "target-colorspace-hint", "yes");
  // Same on-demand-transcode reconnect policy as the Linux addon (see addon.cc):
  // retry seg-0/init 404s, in-progress 503s and transport-level open failures.
  M::set_option_string(g_state.mpv, "demuxer-lavf-o",
      "reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_on_http_error=%7%4xx,5xx,reconnect_delay_max=60");
  if (M::initialize(g_state.mpv) < 0) fprintf(stderr, "[player-mac] mpv_initialize failed\n");
  M::observe_property(g_state.mpv, 1, "time-pos", MPV_FORMAT_DOUBLE);
  M::observe_property(g_state.mpv, 2, "duration", MPV_FORMAT_DOUBLE);
  M::observe_property(g_state.mpv, 3, "pause", MPV_FORMAT_FLAG);
  M::observe_property(g_state.mpv, 4, "track-list", MPV_FORMAT_NONE);
  M::observe_property(g_state.mpv, 5, "paused-for-cache", MPV_FORMAT_FLAG);
  M::request_log_messages(g_state.mpv,
      getenv("FLIKS_MPV_LOGLEVEL") ? getenv("FLIKS_MPV_LOGLEVEL") : "v");
  fprintf(stderr, "[player-mac] mpv ready (hwdec=videotoolbox)\n");

  // Attach the GL layer to the videoWin's content view. N-API runs on the
  // AppKit main thread, so CALayer/NSView mutation here is safe.
  g_view.wantsLayer = YES;
  g_layer = [[MpvGLLayer alloc] init];
  g_layer.opaque = YES;
  g_layer.asynchronous = YES;  // drives its own CVDisplayLink render loop
  g_layer.autoresizingMask = kCALayerWidthSizable | kCALayerHeightSizable;
  ConfigureHdr(g_layer);
  g_layer.frame = g_view.bounds;
  g_layer.contentsScale = g_view.window ? g_view.window.backingScaleFactor : 2.0;
  [g_view.layer addSublayer:g_layer];

  // Keep the layer glued to the view across resize + display (scale) changes.
  g_view.postsFrameChangedNotifications = YES;
  g_frameObserver = [[NSNotificationCenter defaultCenter]
      addObserverForName:NSViewFrameDidChangeNotification
                  object:g_view
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(NSNotification*) { UpdateLayerGeometry(); }];
  g_backingObserver = [[NSNotificationCenter defaultCenter]
      addObserverForName:NSWindowDidChangeBackingPropertiesNotification
                  object:g_view.window
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(NSNotification*) { UpdateLayerGeometry(); }];

  g_state.run.store(true);
  g_state.eventThread = std::thread(EventThreadMain, &g_state);
  return env.Undefined();
}

Napi::Value OnEvent(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) return env.Undefined();
  g_tsfn = EventTSFN::New(env, info[0].As<Napi::Function>(), "fliksMacMpvEvents", 0, 1);
  g_tsfnReady.store(true);
  return env.Undefined();
}

// load({url, startTime?, headers?, subtitles?}) — lifted from addon.cc Load.
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
    const char* cmd[] = {"loadfile", url.c_str(), "replace", "-1", optstr.c_str(), nullptr};
    M::command(g_state.mpv, cmd);
  }
  M::set_property_string(g_state.mpv, "pause", "no");
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
    fprintf(stderr, "[player-mac] set_property %s=%s failed (%d)\n", name.c_str(), val.c_str(), rc);
  return env.Undefined();
}

// resize() — re-fit the layer to the view (PlayerSession resizes the NSWindow).
// Autoresizing + the frame observer normally handle this; expose it so the TS
// layer can force a re-fit (and contentsScale refresh) defensively.
Napi::Value Resize(const Napi::CallbackInfo& info) {
  UpdateLayerGeometry();
  return info.Env().Undefined();
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  g_state.run.store(false);
  // Stop the layer's render loop before freeing the render context.
  if (g_layer) {
    g_layer.asynchronous = NO;
    [g_layer removeFromSuperlayer];
  }
  if (g_frameObserver) {
    [[NSNotificationCenter defaultCenter] removeObserver:g_frameObserver];
    g_frameObserver = nil;
  }
  if (g_backingObserver) {
    [[NSNotificationCenter defaultCenter] removeObserver:g_backingObserver];
    g_backingObserver = nil;
  }
  if (g_state.eventThread.joinable()) g_state.eventThread.join();
  if (g_tsfnReady.exchange(false)) g_tsfn.Release();
  {
    std::lock_guard<std::mutex> lk(g_state.renderMutex);
    if (g_state.mpvGl) {
      // rc_free needs the layer's GL context current.
      if (g_state.cgl) CGLSetCurrentContext(g_state.cgl);
      M::rc_free(g_state.mpvGl);
      g_state.mpvGl = nullptr;
      if (g_state.cgl) {
        CGLSetCurrentContext(nullptr);
        g_state.cgl = nullptr;
      }
    }
  }
  if (g_state.mpv) {
    M::destroy(g_state.mpv);  // mpv_terminate_destroy
    g_state.mpv = nullptr;
  }
  g_layer = nil;
  g_view = nil;
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("onEvent", Napi::Function::New(env, OnEvent));
  exports.Set("load", Napi::Function::New(env, Load));
  exports.Set("command", Napi::Function::New(env, Command));
  exports.Set("getProperty", Napi::Function::New(env, GetProperty));
  exports.Set("setProperty", Napi::Function::New(env, SetProperty));
  exports.Set("resize", Napi::Function::New(env, Resize));
  exports.Set("stop", Napi::Function::New(env, Stop));
  return exports;
}

}  // namespace

NODE_API_MODULE(fliks_player_mac, Init)
