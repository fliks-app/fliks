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
#include <chrono>
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
// Async command dispatch: control-plane calls (pause/seek/track select/…) must
// NOT block the Electron main thread on the mpv core lock, or a busy core (HLS
// network stall, seek, decoder reconfig) head-of-line-blocks the NEXT UI command.
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
  std::atomic<bool> paused{true};  // drives the event thread's position heartbeat
  std::atomic<bool> coreIdle{false};  // mpv not rendering frames (seek/buffer/idle)
  std::atomic<bool> dirty{true};  // force a redraw (resize / first paint)
  // Whether the layer actually got a half-float (RGBA16F) backing. EDR/PQ/HLG
  // tagging is meaningless on an 8-bit unorm FBO (can't carry values >1.0), so
  // ApplyLayerColorConfig gates the HDR branch on this, not just display headroom.
  std::atomic<bool> hdrBacking{false};
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
    g_state.hdrBacking.store(true);
    fprintf(stderr, "[player-mac] GL pixel format: RGBA16F (HDR-capable)\n");
    return pf;
  }
  g_state.hdrBacking.store(false);  // no float backing → EDR/PQ tagging would band
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
  // Hold renderMutex for the same reason drawInCGLContext does: this runs on the
  // layer's CVDisplayLink thread, while Stop() frees mpvGl under the mutex on the
  // main thread. Without the lock, rc_update could poll a handle Stop just freed
  // (run.load() at the top races the free that happens right after it). The mpv
  // update callback (OnMpvUpdate) is a no-op, so there is no re-entrant deadlock.
  std::lock_guard<std::mutex> lk(g_state.renderMutex);
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
id g_screenObserver = nil;        // window moved onto/off a screen
id g_screenParamsObserver = nil;  // display config / EDR headroom changed

// Color class derived from the decoded stream's video-params. Drives the matched
// {mpv target, CALayer colorspace, EDR} triple in ApplyLayerColorConfig, and is
// reclassified on every video-reconfig.
enum ContentColorClass { CC_SDR_709, CC_SDR_P3, CC_HDR_PQ, CC_HLG };
// Last class applied, so a display change (EDR headroom differs per screen) can
// re-evaluate the config without waiting for the next video-params event.
std::atomic<int> g_lastColorClass{CC_SDR_709};
// Last class the event thread dispatched a reconfig for (-1 = none yet / reset on
// load). Guards against re-dispatching an UNCHANGED classification: mpv re-reports
// video-params extremely often (per frame on some streams), and each dispatch runs
// synchronous mpv + CALayer work on the AppKit main thread — a flood there stalls
// the cursor, ipcMain handlers, and video presentation (A/V drift).
std::atomic<int> g_lastReconfigClass{-1};

void UpdateLayerGeometry() {
  if (!g_layer || !g_view) return;
  NSWindow* win = g_view.window;
  CGFloat scale = win ? win.backingScaleFactor : 2.0;
  g_layer.contentsScale = scale;
  g_layer.frame = g_view.bounds;
  g_state.dirty.store(true);
  [g_layer setNeedsDisplay];
}

// Boot the layer into a safe SDR (BT.709 / sRGB) state that matches mpv's default
// gamma-encoded FBO output. The per-content colorspace + EDR decision is deferred
// to ApplyLayerColorConfig, taken once the stream's video-params are decoded (see
// ReconfigureColorForCurrentVideo). Tagging a fixed HDR colorspace here — before
// any file loads, and independent of the content — washed out SDR: an
// extended-linear tag on mpv's gamma-encoded pixels made the compositor skip the
// gamma decode and blow out the midtones.
void BootLayerColorDefaults(MpvGLLayer* layer) {
  if (@available(macOS 10.15, *)) layer.wantsExtendedDynamicRangeContent = NO;
  CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  if (cs) {
    layer.colorspace = cs;
    CGColorSpaceRelease(cs);
  }
}

// Apply the color configuration for a classified content class. MUST run on the
// main queue: it mutates CALayer state (colorspace / wantsEDR) and reads NSScreen,
// both AppKit-main-thread only. The mpv target properties are set here as well
// (thread-safe from any thread) so the FBO encoding and the layer tag — which must
// describe the SAME transfer + primaries — always change together.
//
// Invariant: CALayer.colorspace declares what the framebuffer pixels ALREADY are;
// it does not convert them. So each class pairs an mpv target-trc/-prim with the
// CGColorSpace of that exact encoding. HDR (PQ/HLG) engages EDR only when the
// display has headroom; otherwise mpv tone-maps down to the SDR pair.
void ApplyLayerColorConfig(int clsInt) {
  if (!g_state.run.load() || !g_layer) return;  // torn down (Stop clears g_layer)
  g_lastColorClass.store(clsInt);
  const ContentColorClass cls = static_cast<ContentColorClass>(clsInt);

  // EDR needs BOTH a display with headroom AND a float backing: PQ/HLG + wantsEDR
  // on an 8-bit unorm FBO only bands (can't represent >1.0), so fall back to the
  // SDR tone-map pair there just as on a non-EDR display.
  double headroom = 1.0;
  bool edrOK = false;
  if (@available(macOS 10.15, *)) {
    NSScreen* screen = g_view.window.screen ?: [NSScreen mainScreen];
    headroom = screen.maximumPotentialExtendedDynamicRangeColorComponentValue;
    edrOK = headroom > 1.0 && g_state.hdrBacking.load();
  }

  // SDR-709 defaults — also the fall-back for HDR content on a non-EDR display,
  // where mpv tone-maps the HDR source down to this SDR pair.
  const char* prim = "bt.709";
  const char* trc = "srgb";
  const char* peak = "auto";
  CFStringRef csName = kCGColorSpaceSRGB;
  BOOL wantsEDR = NO;

  if (cls == CC_SDR_P3) {
    prim = "display-p3";  // wide-gamut SDR; sRGB transfer matches Display-P3
    csName = kCGColorSpaceDisplayP3;
  } else if ((cls == CC_HDR_PQ || cls == CC_HLG) && edrOK) {
    if (@available(macOS 11.0, *)) {
      prim = "bt.2020";
      wantsEDR = YES;
      if (cls == CC_HDR_PQ) {
        // target-peak=10000 keeps mpv from tone-mapping, so the full PQ signal
        // reaches the system EDR tonemapper (which soft-clips to the live display
        // headroom); a lower peak would tone-map twice.
        trc = "pq";
        peak = "10000";
        csName = kCGColorSpaceITUR_2100_PQ;
      } else {
        trc = "hlg";  // scene-referred; the system applies the OOTF for the panel
        csName = kCGColorSpaceITUR_2100_HLG;
      }
    }
    // Pre-macOS 11 has no PQ/HLG CGColorSpace → keep the SDR tone-map defaults.
  }

  M::set_property_string(g_state.mpv, "target-prim", prim);
  M::set_property_string(g_state.mpv, "target-trc", trc);
  M::set_property_string(g_state.mpv, "target-peak", peak);

  if (@available(macOS 10.15, *)) g_layer.wantsExtendedDynamicRangeContent = wantsEDR;
  CGColorSpaceRef cs = CGColorSpaceCreateWithName(csName);
  if (cs) {
    g_layer.colorspace = cs;
    CGColorSpaceRelease(cs);
  }

  // Repaint even when paused (no fresh mpv frame) — mirrors UpdateLayerGeometry.
  g_state.dirty.store(true);
  [g_layer setNeedsDisplay];
  static const char* kClassName[] = {"SDR-709", "SDR-P3", "HDR-PQ", "HLG"};
  const char* name = (clsInt >= 0 && clsInt <= CC_HLG) ? kClassName[clsInt] : "?";
  fprintf(stderr,
          "[player-mac] color: class=%s prim=%s trc=%s peak=%s edr=%d "
          "headroom=%.2f hdrBacking=%d\n",
          name, prim, trc, peak, static_cast<int>(wantsEDR), headroom,
          static_cast<int>(g_state.hdrBacking.load()));
}

// Classify the freshly-decoded stream from mpv's video-params and hand the class
// to the main queue. Runs on the event thread; reads mpv properties only. Classify
// on TRANSFER (gamma), never primaries alone — BT.2020-primaries SDR is still SDR.
void ReconfigureColorForCurrentVideo() {
  if (!g_state.mpv) return;
  auto readProp = [](const char* name) -> std::string {
    char* v = M::get_property_string(g_state.mpv, name);
    if (!v) return std::string();
    std::string s(v);
    M::mpv_free(v);
    return s;
  };
  const std::string gamma = readProp("video-params/gamma");
  if (gamma.empty()) return;  // params not ready yet — a later reconfig re-fires
  const std::string primaries = readProp("video-params/primaries");

  const char* forceSdr = getenv("FLIKS_HDR");
  const bool sdrOnly = forceSdr && std::strcmp(forceSdr, "no") == 0;

  ContentColorClass cls;
  if (!sdrOnly && gamma == "pq") {
    cls = CC_HDR_PQ;
  } else if (!sdrOnly && gamma == "hlg") {
    cls = CC_HLG;
  } else if (primaries == "display-p3" || primaries == "dci-p3" || primaries == "bt.2020") {
    cls = CC_SDR_P3;  // present wide gamut on the P3 layer; mpv gamut-maps 2020→P3
  } else {
    cls = CC_SDR_709;
  }

  const int clsInt = static_cast<int>(cls);
  // Reconfigure only when the classification actually changes. mpv fires
  // video-params many times per second even for a static SDR stream; without
  // this guard each fire posts a main-queue block doing synchronous mpv
  // set_property + CALayer work, saturating the AppKit main thread.
  if (clsInt == g_lastReconfigClass.exchange(clsInt)) return;
  // Log the raw mpv enum strings the classification keyed off: the vendored
  // libmpv's exact video-params values must be confirmed on device (see #605), and
  // these are the only place they surface.
  fprintf(stderr, "[player-mac] video-params: gamma=%s primaries=%s -> class=%d\n",
          gamma.c_str(), primaries.c_str(), clsInt);
  dispatch_async(dispatch_get_main_queue(), ^{ ApplyLayerColorConfig(clsInt); });
}

// Emit the UI playback state from the cached pause + core-idle flags. core-idle
// (mpv not rendering frames) distinguishes "buffering/loading" from "playing"
// while NOT user-paused — it is the authoritative signal for the loading spinner
// and, unlike paused-for-cache, it also covers an in-place seek's fetch/decode.
// Clears to "playing" the instant frames flow again (real resume).
void EmitPlaybackState(State* s) {
  if (s->paused.load())
    Emit("{\"type\":\"stateChanged\",\"state\":\"paused\"}");
  else if (s->coreIdle.load())
    Emit("{\"type\":\"stateChanged\",\"state\":\"buffering\"}");
  else
    Emit("{\"type\":\"stateChanged\",\"state\":\"playing\"}");
}

// ── mpv event loop → JS (lifted from addon.cc EventThreadMain) ───────────────
//
// The seekbar position is emitted from HERE (the mpv event thread), never from
// the JS main thread: libmpv's control calls and property reads are synchronous
// and take the mpv core lock, so polling `time-pos`/`demuxer-cache-time` on the
// Electron main thread would park it inside libmpv whenever the core is busy —
// delaying the next pause/seek. Reading them on this thread keeps the main
// thread free for the control plane. `wait_event`'s 0.1s timeout doubles as the
// heartbeat that advances the bar while playing (throttled below to ~4 Hz).
void EventThreadMain(State* s) {
  using clock = std::chrono::steady_clock;
  auto lastEmit = clock::now() - std::chrono::seconds(1);  // allow an immediate first emit
  const auto kEmitInterval = std::chrono::milliseconds(250);

  auto emitPosition = [&](bool force) {
    if (!s->run.load(std::memory_order_acquire)) return;
    const auto now = clock::now();
    if (!force && now - lastEmit < kEmitInterval) return;
    lastEmit = now;  // throttle the read ATTEMPT too, so a null gap can't spin the loop
    char* tp = M::get_property_string(s->mpv, "time-pos");
    // No current position: a load/seek gap where mpv has torn down the old
    // timeline but not yet decoded the new one (e.g. a quality-change reload).
    // Emitting here would push position:0 and collapse the seekbar — hold the
    // last value instead; PLAYBACK_RESTART re-emits the resumed position.
    if (!tp) return;
    char* cache = M::get_property_string(s->mpv, "demuxer-cache-time");
    const double pos = atof(tp);
    const double buf = cache ? atof(cache) : 0.0;
    M::mpv_free(tp);
    if (cache) M::mpv_free(cache);
    char pb[32], db[32], bb[32];
    snprintf(pb, sizeof(pb), "%.3f", pos);
    snprintf(db, sizeof(db), "%.3f", s->duration);
    snprintf(bb, sizeof(bb), "%.3f", buf);
    Emit(std::string("{\"type\":\"timeUpdate\",\"position\":") + pb +
         ",\"duration\":" + db + ",\"buffered\":" + bb + "}");
  };

  while (s->run.load(std::memory_order_acquire)) {
    mpv_event* ev = M::wait_event(s->mpv, 0.1);
    if (ev && ev->event_id != MPV_EVENT_NONE) {
      switch (ev->event_id) {
        case MPV_EVENT_PROPERTY_CHANGE: {
          auto* p = static_cast<mpv_event_property*>(ev->data);
          if (!p) break;
          if (std::strcmp(p->name, "track-list") == 0) {
            // Carry the committed track-list value in the event (read here on the
            // event thread, at the moment of the change) — parity with the Windows
            // backend. Letting the client re-read the property later can observe a
            // transient deselect/reselect state, which churns the audio track
            // selection and lets the wrong default language stick.
            char* tl = M::get_property_string(s->mpv, "track-list");
            Emit(std::string("{\"type\":\"tracksChanged\",\"tracks\":") + (tl ? tl : "[]") + "}");
            if (tl) M::mpv_free(tl);
            break;
          }
          if (std::strcmp(p->name, "video-params/gamma") == 0 ||
              std::strcmp(p->name, "video-params/primaries") == 0) {
            // Typed leaf observe → fires only on a real color change; re-read both
            // leaves and reclassify (cheap, now rare).
            ReconfigureColorForCurrentVideo();
            break;
          }
          if (!p->data) break;
          if (std::strcmp(p->name, "duration") == 0 && p->format == MPV_FORMAT_DOUBLE) {
            s->duration = *static_cast<double*>(p->data);
          } else if (std::strcmp(p->name, "pause") == 0 && p->format == MPV_FORMAT_FLAG) {
            s->paused.store(*static_cast<int*>(p->data) != 0);
            EmitPlaybackState(s);
          } else if (std::strcmp(p->name, "core-idle") == 0 && p->format == MPV_FORMAT_FLAG) {
            s->coreIdle.store(*static_cast<int*>(p->data) != 0);
            EmitPlaybackState(s);
          }
          break;
        }
        case MPV_EVENT_LOG_MESSAGE: {
          auto* m = static_cast<mpv_event_log_message*>(ev->data);
          if (m) fprintf(stderr, "[mpv] %s: %s", m->prefix, m->text);
          break;
        }
        case MPV_EVENT_PLAYBACK_RESTART:
          // Guarantee the color config is applied once per load/seek even if the
          // typed video-params leaf observe misses its initial change (the
          // g_lastReconfigClass guard makes this a no-op when unchanged).
          ReconfigureColorForCurrentVideo();
          emitPosition(true);  // push the fresh position right after a seek / first frame
          Emit("{\"type\":\"firstFrame\"}");
          break;
        case MPV_EVENT_END_FILE: {
          s->paused.store(true);  // playback stopped (stop/eof/error) → halt the heartbeat
          auto* e = static_cast<mpv_event_end_file*>(ev->data);
          if (e && e->reason == MPV_END_FILE_REASON_EOF)
            Emit("{\"type\":\"stateChanged\",\"state\":\"ended\"}");
          else if (e && e->reason == MPV_END_FILE_REASON_ERROR)
            Emit("{\"type\":\"error\",\"message\":\"end-file error\"}");
          break;
        }
        case MPV_EVENT_COMMAND_REPLY:
        case MPV_EVENT_SET_PROPERTY_REPLY:
          // Async control-plane acks. Only surface failures; success is silent.
          if (ev->error < 0)
            fprintf(stderr, "[player-mac] async command failed: %s\n", M::error_string(ev->error));
          break;
        default:
          break;
      }
    }
    // Heartbeat the seekbar while playing (throttled inside emitPosition).
    if (!s->paused.load()) emitPosition(false);
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
  // Color management is content-adaptive: target-prim/-trc/-peak are set per
  // decoded stream in ApplyLayerColorConfig, matched to the CALayer colorspace.
  // target-colorspace-hint is deliberately NOT set — it is inert on the render
  // API (it needs vo=gpu-next plus a Wayland/D3D11/winvk swapchain, none of which
  // exist for a host-owned CAOpenGLLayer FBO).
  // Streaming/buffering/reconnect tuning is applied from TS after start
  // (MPV_STREAM_OPTIONS in src/shared/mpv-stream-options.ts) — one source of
  // truth shared with the Linux + Windows backends.
  if (M::initialize(g_state.mpv) < 0) fprintf(stderr, "[player-mac] mpv_initialize failed\n");
  // time-pos is read on demand by the event thread's position heartbeat (see
  // EventThreadMain), so it is deliberately NOT observed — observing it would
  // wake the loop on every frame for no gain.
  M::observe_property(g_state.mpv, 2, "duration", MPV_FORMAT_DOUBLE);
  M::observe_property(g_state.mpv, 3, "pause", MPV_FORMAT_FLAG);
  M::observe_property(g_state.mpv, 4, "track-list", MPV_FORMAT_NONE);
  M::observe_property(g_state.mpv, 5, "core-idle", MPV_FORMAT_FLAG);
  // Drive the content-adaptive colorspace/EDR reconfiguration off the two color
  // leaves we actually classify on, observed as TYPED strings. The aggregate
  // `video-params` belongs to mpv's per-frame TICK group, so observing it with
  // MPV_FORMAT_NONE delivers a change pulse on EVERY displayed frame (no value
  // comparison) — thousands per session — flooding the event thread and (via the
  // main-queue reconfig) the AppKit thread. A typed leaf observe makes mpv compare
  // the value itself and wake us only on a genuine gamma/primaries change.
  M::observe_property(g_state.mpv, 6, "video-params/gamma", MPV_FORMAT_STRING);
  M::observe_property(g_state.mpv, 7, "video-params/primaries", MPV_FORMAT_STRING);
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
  BootLayerColorDefaults(g_layer);
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
  // Re-evaluate the colorspace/EDR config for the current content whenever the
  // display situation changes. Three notifications, because none covers every case:
  //   • backing-properties — scale/colorspace change on the SAME screen;
  //   • window-did-change-screen — the window moves onto/off a screen (fires even
  //     when the two screens share scale + colorspace, which backing-properties
  //     misses);
  //   • app screen-parameters — headroom changes with no window move (display
  //     brightness, system-HDR toggle, panel entering/leaving reference mode).
  void (^reeval)(NSNotification*) = ^(NSNotification*) {
    UpdateLayerGeometry();
    ApplyLayerColorConfig(g_lastColorClass.load());
  };
  NSNotificationCenter* nc = [NSNotificationCenter defaultCenter];
  g_backingObserver = [nc addObserverForName:NSWindowDidChangeBackingPropertiesNotification
                                      object:g_view.window
                                       queue:[NSOperationQueue mainQueue]
                                  usingBlock:reeval];
  g_screenObserver = [nc addObserverForName:NSWindowDidChangeScreenNotification
                                     object:g_view.window
                                      queue:[NSOperationQueue mainQueue]
                                 usingBlock:reeval];
  // object:nil — headroom is a display-global property, not window-scoped.
  g_screenParamsObserver =
      [nc addObserverForName:NSApplicationDidChangeScreenParametersNotification
                     object:nil
                      queue:[NSOperationQueue mainQueue]
                 usingBlock:reeval];

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
  // Preferred audio language → mpv auto-selects the matching rendition on this
  // load and re-applies it on every reconfig, so it never reverts to the
  // manifest's default track (which may be a different language).
  if (o.Has("audioLanguage") && o.Get("audioLanguage").IsString()) {
    std::string lang = o.Get("audioLanguage").As<Napi::String>().Utf8Value();
    if (!lang.empty()) opts.push_back("alang=" + lang);
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
  // mpv autoplays on load but may not emit a pause change, so mark playing here
  // directly — the event thread's position heartbeat gates on this flag.
  g_state.paused.store(false);
  // Force the next video-params event to re-apply the color config once for the
  // new stream (its class may match the previous file's).
  g_lastReconfigClass.store(-1);
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

// Fire an mpv command WITHOUT blocking the calling (Electron main) thread: mpv
// copies the argv during the call and applies the command on its own thread, so
// a busy core can't stall the next UI command. The reply (id 0) is ignored on
// the event thread (COMMAND_REPLY), which only logs failures.
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

// Set a property via the async `set` command (equivalent to set_property_string
// but non-blocking) for the same reason Command is async: pause/volume/track
// selection must never block the Electron main thread on the mpv core lock.
Napi::Value SetProperty(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_state.mpv || info.Length() < 2) return env.Undefined();
  std::string name = info[0].As<Napi::String>().Utf8Value();
  std::string val = info[1].ToString().Utf8Value();
  const char* argv[] = {"set", name.c_str(), val.c_str(), nullptr};
  M::command_async(g_state.mpv, 0, argv);
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
  // run.store(false) MUST stay first: a still-queued ApplyLayerColorConfig block
  // (posted from the event thread) is only safe because it early-returns on
  // !run, and it runs on this same main thread so it can't interleave with the
  // g_layer=nil below. mpv itself is destroyed only after eventThread.join(), so
  // the event thread has stopped reading g_state.mpv by then.
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
  if (g_screenObserver) {
    [[NSNotificationCenter defaultCenter] removeObserver:g_screenObserver];
    g_screenObserver = nil;
  }
  if (g_screenParamsObserver) {
    [[NSNotificationCenter defaultCenter] removeObserver:g_screenParamsObserver];
    g_screenParamsObserver = nil;
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
