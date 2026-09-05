// fliks_player_mac — in-process libmpv embed for macOS.
//
// Unlike Linux (a self-compositing SDL/GLES window) and Windows (an mpv
// SUBPROCESS embedded via --wid), macOS embeds libmpv IN-PROCESS: mpv's
// subprocess --wid crashes there ("--wid works only with libmpv"), and the
// macOS window server already composites sibling windows correctly, so no
// self-compositor is needed.
//
// The Electron videoWin's content NSView (getNativeWindowHandle) hosts a
// CAMetalLayer; mpv still renders through the OpenGL render API (the only GPU
// backend in vendored libmpv) into an offscreen FBO backed by an IOSurface. A
// dedicated render thread owns a headless CGL context end to end: it renders
// each frame into the IOSurface-backed FBO, then Metal blit-copies that
// IOSurface into the layer's next drawable. This indirection is what buys
// CAEDRMetadata (HDR10/HLG tonemapping hints), which CAOpenGLLayer can't carry.
// The sibling uiWin (a real Electron window owned by videoWin) draws the
// controls above it.
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
#import <OpenGL/CGLIOSurface.h>
#import <Metal/Metal.h>
#import <IOSurface/IOSurface.h>
#import <CoreVideo/CVPixelBuffer.h>
#import <CoreFoundation/CoreFoundation.h>

#include <mpv/client.h>
#include <mpv/render.h>
#include <mpv/render_gl.h>

#include <dlfcn.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iterator>
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
  mpv_render_context* mpvGl = nullptr;  // render-thread-confined: created, used, freed there
  std::atomic<bool> run{false};
  std::atomic<bool> paused{true};  // drives the event thread's position heartbeat
  std::atomic<bool> coreIdle{false};  // mpv not rendering frames (seek/buffer/idle)
  std::atomic<bool> dirty{true};  // force a redraw (resize / first paint / color change)
  // Whether the layer actually got a half-float (RGBA16F) backing. EDR/PQ/HLG
  // tagging is meaningless on an 8-bit unorm FBO (can't carry values >1.0), so
  // ApplyLayerColorConfig gates the HDR branch on this, not just display headroom.
  std::atomic<bool> hdrBacking{false};
  std::thread eventThread;
  std::thread renderThread;
  std::atomic<uint64_t> desiredSize{0};  // packed w<<32|h, set by UpdateLayerGeometry
  std::mutex wakeMutex;
  std::condition_variable wakeCv;
  std::atomic<bool> wake{false};
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

// mpv forbids calling its API from this callback (render.h) — just wake the
// render thread, which does the actual rc_update/rc_render.
void OnMpvUpdate(void*) {
  g_state.wake.store(true);
  g_state.wakeCv.notify_one();
}

void Emit(const std::string& json) {
  if (g_tsfnReady.load()) g_tsfn.BlockingCall(new std::string(json));
}

// Nudge the render thread to redraw even without a fresh mpv frame (resize,
// pause, color reconfig). Replaces CAOpenGLLayer's setNeedsDisplay, which is
// inert on CAMetalLayer.
void RequestRedraw() {
  g_state.dirty.store(true);
  g_state.wakeCv.notify_one();
}

// GL/IOSurface/Metal format triple chosen once in Start(), read only by the
// render thread thereafter.
struct PixelFormatChoice {
  MTLPixelFormat mtlFormat = MTLPixelFormatInvalid;
  OSType ioSurfaceFormat = 0;
  size_t bytesPerElement = 0;
  GLint glInternalFormat = 0;
  GLenum glFormat = 0;
  GLenum glType = 0;
};
PixelFormatChoice g_pixelFormat;

// mpv renders into slot.fbo (an IOSurface-backed GL_TEXTURE_RECTANGLE); the
// same IOSurface is wrapped as slot.mtl and blit-copied into the layer's
// drawable. Ring of 2: while GL writes one slot, Metal may still be reading
// the other slot's blit from the previous frame — a single surface would tear.
struct SurfaceSlot {
  IOSurfaceRef surf = nullptr;
  GLuint tex = 0;
  GLuint fbo = 0;
  id<MTLTexture> mtl = nil;
  std::atomic<bool> busy{false};  // set before commit, cleared in the completion handler
  int width = 0;
  int height = 0;
};
SurfaceSlot g_ring[2];

CAMetalLayer* g_layer = nil;
NSView* g_view = nil;  // not owned (Electron's content view)
id<MTLDevice> g_device = nil;
id<MTLCommandQueue> g_queue = nil;
id g_backingObserver = nil;
id g_frameObserver = nil;
id g_screenObserver = nil;        // window moved onto/off a screen
id g_screenParamsObserver = nil;  // display config / EDR headroom changed

// Render thread: owns a headless CGL context end to end (create → rc_create →
// per-frame render → rc_free → destroy). Replaces CAOpenGLLayer's
// CVDisplayLink-driven canDrawInCGLContext/drawInCGLContext; woken by
// OnMpvUpdate via the wake condvar instead of vsync polling.
void RenderThreadMain(State* s) {
  CGLPixelFormatAttribute attrs[] = {
      kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core,
      kCGLPFAAccelerated,
      kCGLPFAAllowOfflineRenderers,
      (CGLPixelFormatAttribute)0,
  };
  CGLPixelFormatObj pf = nullptr;
  GLint npix = 0;
  CGLChoosePixelFormat(attrs, &pf, &npix);
  CGLContextObj cgl = nullptr;
  if (pf) {
    CGLCreateContext(pf, nullptr, &cgl);
    CGLDestroyPixelFormat(pf);
  }
  if (!cgl) {
    fprintf(stderr, "[player-mac] CGLCreateContext failed\n");
    while (s->run.load()) std::this_thread::sleep_for(std::chrono::milliseconds(100));
    return;
  }
  CGLSetCurrentContext(cgl);

  mpv_opengl_init_params gl_init{};
  gl_init.get_proc_address = GetProcGL;
  gl_init.get_proc_address_ctx = nullptr;
  int advanced = 1;
  mpv_render_param create_params[] = {
      {MPV_RENDER_PARAM_API_TYPE, const_cast<char*>(MPV_RENDER_API_TYPE_OPENGL)},
      {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl_init},
      {MPV_RENDER_PARAM_ADVANCED_CONTROL, &advanced},
      {static_cast<mpv_render_param_type>(0), nullptr},
  };
  int rc = M::rc_create(&s->mpvGl, s->mpv, create_params);
  if (rc < 0) {
    fprintf(stderr, "[player-mac] rc_create failed: %s\n", M::error_string(rc));
    CGLSetCurrentContext(nullptr);
    CGLDestroyContext(cgl);
    while (s->run.load()) std::this_thread::sleep_for(std::chrono::milliseconds(100));
    return;
  }
  M::rc_set_update_callback(s->mpvGl, OnMpvUpdate, s);
  fprintf(stderr, "[player-mac] mpv render context ready\n");

  const bool hasUnifiedMemory = g_device.hasUnifiedMemory;
  int ringW = 0, ringH = 0;
  uint64_t frameIndex = 0;

  auto waitUntilFree = [&](SurfaceSlot& slot) {
    std::unique_lock<std::mutex> lk(s->wakeMutex);
    s->wakeCv.wait(lk, [&] { return !slot.busy.load() || !s->run.load(); });
  };
  auto releaseSlot = [&](SurfaceSlot& slot) {
    if (slot.fbo) { glDeleteFramebuffers(1, &slot.fbo); slot.fbo = 0; }
    if (slot.tex) { glDeleteTextures(1, &slot.tex); slot.tex = 0; }
    slot.mtl = nil;
    if (slot.surf) { CFRelease(slot.surf); slot.surf = nullptr; }
    slot.width = slot.height = 0;
  };
  auto buildSlot = [&](SurfaceSlot& slot, int w, int h) {
    NSDictionary* props = @{
      (id)kIOSurfaceWidth : @(w),
      (id)kIOSurfaceHeight : @(h),
      (id)kIOSurfaceBytesPerElement : @(g_pixelFormat.bytesPerElement),
      (id)kIOSurfacePixelFormat : @(g_pixelFormat.ioSurfaceFormat),
    };
    slot.surf = IOSurfaceCreate((__bridge CFDictionaryRef)props);
    glGenTextures(1, &slot.tex);
    glBindTexture(GL_TEXTURE_RECTANGLE, slot.tex);
    CGLTexImageIOSurface2D(cgl, GL_TEXTURE_RECTANGLE, g_pixelFormat.glInternalFormat, w, h,
                           g_pixelFormat.glFormat, g_pixelFormat.glType, slot.surf, 0);
    glTexParameteri(GL_TEXTURE_RECTANGLE, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_RECTANGLE, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glGenFramebuffers(1, &slot.fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, slot.fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_RECTANGLE, slot.tex, 0);
    glClearColor(0, 0, 0, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);

    MTLTextureDescriptor* desc =
        [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:g_pixelFormat.mtlFormat
                                                            width:w
                                                           height:h
                                                        mipmapped:NO];
    desc.usage = MTLTextureUsageShaderRead;
    desc.storageMode = hasUnifiedMemory ? MTLStorageModeShared : MTLStorageModeManaged;
    slot.mtl = [g_device newTextureWithDescriptor:desc iosurface:slot.surf plane:0];
    slot.width = w;
    slot.height = h;
  };

  while (s->run.load()) {
    {
      std::unique_lock<std::mutex> lk(s->wakeMutex);
      s->wakeCv.wait_for(lk, std::chrono::milliseconds(100),
                         [s] { return s->wake.load() || s->dirty.load() || !s->run.load(); });
      s->wake.store(false);
    }
    if (!s->run.load()) break;

    uint64_t flags = M::rc_update(s->mpvGl);  // ADVANCED_CONTROL: required after every callback
    if (!(flags & MPV_RENDER_UPDATE_FRAME) && !s->dirty.load()) continue;
    s->dirty.store(false);

    const uint64_t packed = s->desiredSize.load();
    const int w = static_cast<int>(packed >> 32);
    const int h = static_cast<int>(packed & 0xffffffffu);
    if (w <= 0 || h <= 0) continue;

    if (w != ringW || h != ringH) {
      glFinish();
      for (auto& slot : g_ring) waitUntilFree(slot);
      for (auto& slot : g_ring) releaseSlot(slot);
      for (auto& slot : g_ring) buildSlot(slot, w, h);
      ringW = w;
      ringH = h;
    }

    SurfaceSlot& slot = g_ring[frameIndex++ & 1];
    if (slot.busy.load()) waitUntilFree(slot);  // never in practice at ring size 2

    mpv_opengl_fbo mfbo{static_cast<int>(slot.fbo), w, h, g_pixelFormat.glInternalFormat};
    // No FLIP_Y: mpv's render-API output is top-down, and so is an FBO texture
    // (unlike the CAOpenGLLayer default framebuffer, which is bottom-up). If
    // the first SDR frame renders upside down, re-add flip=1 here.
    mpv_render_param render_params[] = {
        {MPV_RENDER_PARAM_OPENGL_FBO, &mfbo},
        {static_cast<mpv_render_param_type>(0), nullptr},
    };
    M::rc_render(s->mpvGl, render_params);
    glFlush();  // ensure GL's IOSurface writes are visible before the Metal blit reads it

    id<CAMetalDrawable> drawable = [g_layer nextDrawable];
    if (!drawable) {
      s->dirty.store(true);  // retry next wake instead of dropping the frame
      continue;
    }

    id<MTLCommandBuffer> cb = [g_queue commandBuffer];
    id<MTLBlitCommandEncoder> blit = [cb blitCommandEncoder];
    // min() guards the one-frame race where a resize lands between the GL
    // render above and this blit (drawable and slot briefly disagree in size).
    MTLSize copySize = MTLSizeMake(
        std::min<NSUInteger>(slot.width, drawable.texture.width),
        std::min<NSUInteger>(slot.height, drawable.texture.height), 1);
    [blit copyFromTexture:slot.mtl
               sourceSlice:0
               sourceLevel:0
              sourceOrigin:MTLOriginMake(0, 0, 0)
                sourceSize:copySize
                 toTexture:drawable.texture
          destinationSlice:0
          destinationLevel:0
         destinationOrigin:MTLOriginMake(0, 0, 0)];
    [blit endEncoding];
    [cb presentDrawable:drawable];
    slot.busy.store(true);
    [cb addCompletedHandler:^(id<MTLCommandBuffer>) {
      // Clear under wakeMutex: an unlocked store can land between waitUntilFree's
      // predicate check and its block, losing the wakeup and stalling the loop.
      {
        std::lock_guard<std::mutex> lk(s->wakeMutex);
        slot.busy.store(false);
      }
      s->wakeCv.notify_one();
    }];
    [cb commit];
    M::rc_report_swap(s->mpvGl);
  }

  if (s->mpvGl) {
    M::rc_free(s->mpvGl);
    s->mpvGl = nullptr;
  }
  for (auto& slot : g_ring) releaseSlot(slot);
  CGLSetCurrentContext(nullptr);
  CGLDestroyContext(cgl);
}

// Color class derived from the decoded stream's video-params. Drives the matched
// {mpv target, CALayer colorspace, EDR} triple in ApplyLayerColorConfig, and is
// reclassified on every video-reconfig.
enum ContentColorClass { CC_SDR_709, CC_SDR_P3, CC_HDR_PQ, CC_HLG };
// Last class applied, so a display change (EDR headroom differs per screen) can
// re-evaluate the config without waiting for the next video-params event.
std::atomic<int> g_lastColorClass{CC_SDR_709};
// Last (class, mastering-peak) key the event thread dispatched a reconfig for
// (~0 = none yet / reset on load). Guards against re-dispatching an UNCHANGED
// classification: mpv re-reports video-params extremely often (per frame on
// some streams), and each dispatch runs synchronous mpv + CALayer work on the
// AppKit main thread — a flood there stalls the cursor, ipcMain handlers, and
// video presentation (A/V drift). Keying on the peak too (not just the class)
// re-dispatches when the mastering luminance changes under an unchanged class.
std::atomic<uint64_t> g_lastReconfigKey{~0ull};

uint32_t FloatBits(float f) {
  uint32_t bits;
  std::memcpy(&bits, &f, sizeof(bits));
  return bits;
}

// HDR mastering/content-light metadata read alongside the color class, for
// CAEDRMetadata. Only populated for CC_HDR_PQ (see ReconfigureColorForCurrentVideo).
struct HdrMeta {
  double maxLuma = 0;  // video-params/max-luma (mastering display peak, nits)
  double minLuma = 0;  // video-params/min-luma
  double maxCll = 0;   // video-params/max-cll (unused: no MDCV/CLLI byte-packing yet)
  double maxFall = 0;  // video-params/max-fall (unused: no MDCV/CLLI byte-packing yet)
};
HdrMeta g_lastHdrMeta;  // main-thread only; reused when re-evaluating for a display change

void UpdateLayerGeometry() {
  if (!g_layer || !g_view) return;
  NSWindow* win = g_view.window;
  CGFloat scale = win ? win.backingScaleFactor : 2.0;
  g_layer.contentsScale = scale;
  g_layer.frame = g_view.bounds;
  CGSize drawableSize =
      CGSizeMake(g_view.bounds.size.width * scale, g_view.bounds.size.height * scale);
  g_layer.drawableSize = drawableSize;
  g_state.desiredSize.store((static_cast<uint64_t>(drawableSize.width) << 32) |
                             static_cast<uint32_t>(drawableSize.height));
  RequestRedraw();
}

// Boot the layer into a safe SDR (BT.709 / sRGB) state that matches mpv's default
// gamma-encoded FBO output. The per-content colorspace + EDR decision is deferred
// to ApplyLayerColorConfig, taken once the stream's video-params are decoded (see
// ReconfigureColorForCurrentVideo). Tagging a fixed HDR colorspace here — before
// any file loads, and independent of the content — washed out SDR: an
// extended-linear tag on mpv's gamma-encoded pixels made the compositor skip the
// gamma decode and blow out the midtones.
void BootLayerColorDefaults(CAMetalLayer* layer) {
  if (@available(macOS 10.15, *)) layer.wantsExtendedDynamicRangeContent = NO;
  CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  if (cs) {
    layer.colorspace = cs;
    CGColorSpaceRelease(cs);
  }
}

// Apply the color configuration for a classified content class. MUST run on the
// main queue: it mutates CALayer state (colorspace / wantsEDR / EDRMetadata) and
// reads NSScreen, both AppKit-main-thread only. The mpv target properties are set
// here as well (thread-safe from any thread) so the FBO encoding and the layer
// tag — which must describe the SAME transfer + primaries — always change together.
//
// Invariant: CALayer.colorspace declares what the framebuffer pixels ALREADY are;
// it does not convert them. So each class pairs an mpv target-trc/-prim with the
// CGColorSpace of that exact encoding. HDR (PQ/HLG) engages EDR only when the
// display has headroom; otherwise mpv tone-maps down to the SDR pair.
void ApplyLayerColorConfig(int clsInt, HdrMeta meta) {
  if (!g_state.run.load() || !g_layer) return;  // torn down (Stop clears g_layer)
  g_lastColorClass.store(clsInt);
  g_lastHdrMeta = meta;
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

  // Buffer encoding context: the PQ path writes PQ-encoded fp16 in [0,1] and the
  // layer colorspace is ITUR_2100_PQ, an ABSOLUTE transfer function (signal 1.0
  // == 10000 nits) — hence opticalOutputScale=10000 (scale=100 is only correct
  // for an extended-linear recipe, which would need target-trc=linear instead).
  // Takes effect on subsequent nextDrawable calls, same one-frame lag as colorspace.
  if (@available(macOS 10.15, *)) {
    bool hwOk = true;
    if (@available(macOS 13.0, *)) hwOk = CAEDRMetadata.isAvailable;
    if (wantsEDR && hwOk && cls == CC_HDR_PQ) {
      g_layer.EDRMetadata =
          meta.maxLuma > 0
              ? [CAEDRMetadata HDR10MetadataWithMinLuminance:(float)meta.minLuma
                                                 maxLuminance:(float)meta.maxLuma
                                           opticalOutputScale:10000.0f]
              : [CAEDRMetadata HDR10MetadataWithDisplayInfo:nil
                                                 contentInfo:nil
                                          opticalOutputScale:10000.0f];
    } else if (wantsEDR && hwOk && cls == CC_HLG) {
      g_layer.EDRMetadata = CAEDRMetadata.HLGMetadata;
    } else {
      g_layer.EDRMetadata = nil;
    }
  }

  // Repaint even when paused (no fresh mpv frame) — mirrors UpdateLayerGeometry.
  RequestRedraw();
  static const char* kClassName[] = {"SDR-709", "SDR-P3", "HDR-PQ", "HLG"};
  const char* name = (clsInt >= 0 && clsInt <= CC_HLG) ? kClassName[clsInt] : "?";
  fprintf(stderr,
          "[player-mac] color: class=%s prim=%s trc=%s peak=%s edr=%d "
          "headroom=%.2f hdrBacking=%d maxLuma=%.1f minLuma=%.4f\n",
          name, prim, trc, peak, static_cast<int>(wantsEDR), headroom,
          static_cast<int>(g_state.hdrBacking.load()), meta.maxLuma, meta.minLuma);
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

  HdrMeta meta;
  if (cls == CC_HDR_PQ) {
    auto readNum = [&](const char* name) -> double {
      std::string s = readProp(name);
      return s.empty() ? 0.0 : atof(s.c_str());
    };
    meta.maxLuma = readNum("video-params/max-luma");
    meta.minLuma = readNum("video-params/min-luma");
    meta.maxCll = readNum("video-params/max-cll");
    meta.maxFall = readNum("video-params/max-fall");
  }

  const int clsInt = static_cast<int>(cls);
  // Reconfigure only when the classification OR the mastering peak actually
  // changes. mpv fires video-params many times per second even for a static
  // stream; without this guard each fire posts a main-queue block doing
  // synchronous mpv set_property + CALayer work, saturating the AppKit main
  // thread.
  const uint64_t key =
      (static_cast<uint64_t>(clsInt) << 32) | FloatBits(static_cast<float>(meta.maxLuma));
  if (key == g_lastReconfigKey.exchange(key)) return;
  // Log the raw mpv enum strings the classification keyed off: the vendored
  // libmpv's exact video-params values must be confirmed on device (see #605), and
  // these are the only place they surface.
  fprintf(stderr, "[player-mac] video-params: gamma=%s primaries=%s maxLuma=%.1f -> class=%d\n",
          gamma.c_str(), primaries.c_str(), meta.maxLuma, clsInt);
  dispatch_async(dispatch_get_main_queue(), ^{ ApplyLayerColorConfig(clsInt, meta); });
}

// mpv documents the video-params enum values as subject to change, and the
// vendored libmpv tracks whatever version Homebrew serves (vendor-libmpv-mac.sh
// pins nothing). A rename degrades silently — an unrecognised gamma classifies as
// CC_SDR_709, so HDR would play tone-mapped with no error — so check the names
// ReconfigureColorForCurrentVideo compares against once at startup. mpv's own
// choice lists come from the same tables that format video-params.
void VerifyColorEnums() {
  if (!g_state.mpv) return;
  if (char* ver = M::get_property_string(g_state.mpv, "mpv-version")) {
    fprintf(stderr, "[player-mac] libmpv version: %s\n", ver);
    M::mpv_free(ver);
  }
  const struct {
    const char* prop;
    const char* expected[4];
  } kChecks[] = {
      {"option-info/target-trc/choices", {"pq", "hlg"}},
      {"option-info/target-prim/choices", {"display-p3", "dci-p3", "bt.2020"}},
  };
  for (const auto& check : kChecks) {
    char* raw = M::get_property_string(g_state.mpv, check.prop);
    if (!raw) {
      fprintf(stderr, "[player-mac] color: cannot read %s\n", check.prop);
      continue;
    }
    const std::string csv = std::string(",") + raw + ",";
    M::mpv_free(raw);
    for (const char* const* name = check.expected; name < std::end(check.expected) && *name;
         ++name) {
      if (csv.find(std::string(",") + *name + ",") == std::string::npos) {
        fprintf(stderr,
                "[player-mac] color: libmpv no longer knows '%s' in %s — content "
                "classification will fall back to SDR-709\n",
                *name, check.prop);
      }
    }
  }
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
          // g_lastReconfigKey guard makes this a no-op when unchanged).
          ReconfigureColorForCurrentVideo();
          emitPosition(true);  // push the fresh position right after a seek / first frame
          Emit("{\"type\":\"firstFrame\"}");
          break;
        case MPV_EVENT_END_FILE: {
          // Do NOT touch s->paused here: it must mirror ONLY mpv's pause property
          // (the pause observe), or a reload's old-file END_FILE leaves paused=true
          // and the next core-idle→playing emits "paused", flipping the button. The
          // heartbeat halts on its own via the core-idle gate (idle at EOF/stop).
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
    // Heartbeat the seekbar only while actually rendering frames. Gate on
    // core-idle (false = playing) rather than pause: it also covers seek/buffer/
    // EOF, so the position never advances while frozen, and it keeps s->paused
    // strictly the pause property (used for the play/pause UI state).
    if (!s->coreIdle.load()) emitPosition(false);
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
  // exist for a host-owned CAMetalLayer FBO).
  // Streaming/buffering/reconnect tuning is applied from TS after start
  // (MPV_STREAM_OPTIONS in src/shared/mpv-stream-options.ts) — one source of
  // truth shared with the Linux + Windows backends.
  if (M::initialize(g_state.mpv) < 0) fprintf(stderr, "[player-mac] mpv_initialize failed\n");
  VerifyColorEnums();
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

  // Attach the Metal layer to the videoWin's content view. N-API runs on the
  // AppKit main thread, so CALayer/NSView mutation here is safe.
  g_view.wantsLayer = YES;

  const char* forceSdr = getenv("FLIKS_HDR");
  const bool wantHdr = !(forceSdr && std::strcmp(forceSdr, "no") == 0);
  g_device = MTLCreateSystemDefaultDevice();
  if (!g_device) {
    Napi::Error::New(env, "MTLCreateSystemDefaultDevice failed").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  g_queue = [g_device newCommandQueue];
  if (wantHdr) {
    g_pixelFormat = {MTLPixelFormatRGBA16Float, kCVPixelFormatType_64RGBAHalf, 8,
                      GL_RGBA16F, GL_RGBA, GL_HALF_FLOAT};
    fprintf(stderr, "[player-mac] metal pixel format: RGBA16F (HDR-capable)\n");
  } else {
    g_pixelFormat = {MTLPixelFormatBGRA8Unorm, kCVPixelFormatType_32BGRA, 4,
                      GL_RGBA8, GL_BGRA, GL_UNSIGNED_INT_8_8_8_8_REV};
    fprintf(stderr, "[player-mac] metal pixel format: BGRA8 (SDR)\n");
  }
  g_state.hdrBacking.store(wantHdr);

  g_layer = [CAMetalLayer layer];
  g_layer.device = g_device;
  g_layer.pixelFormat = g_pixelFormat.mtlFormat;
  g_layer.opaque = YES;
  g_layer.framebufferOnly = NO;  // a framebufferOnly drawable rejects blit destinations
  g_layer.backgroundColor = CGColorGetConstantColor(kCGColorBlack);
  g_layer.autoresizingMask = kCALayerWidthSizable | kCALayerHeightSizable;
  BootLayerColorDefaults(g_layer);
  g_layer.frame = g_view.bounds;
  CGFloat scale = g_view.window ? g_view.window.backingScaleFactor : 2.0;
  g_layer.contentsScale = scale;
  CGSize drawableSize =
      CGSizeMake(g_view.bounds.size.width * scale, g_view.bounds.size.height * scale);
  g_layer.drawableSize = drawableSize;
  g_state.desiredSize.store((static_cast<uint64_t>(drawableSize.width) << 32) |
                             static_cast<uint32_t>(drawableSize.height));
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
    ApplyLayerColorConfig(g_lastColorClass.load(), g_lastHdrMeta);
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
  g_state.renderThread = std::thread(RenderThreadMain, &g_state);
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
  g_lastReconfigKey.store(~0ull);
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

// Path for `r` with only the two corners on one Y-edge rounded. bottomIsMinY
// selects which edge is "bottom" in the layer's geometry (a non-flipped AppKit
// view has its bottom at minY; a flipped Chromium view at maxY).
static CGPathRef CreateBottomRoundedPath(CGRect r, CGFloat radius, BOOL bottomIsMinY) {
  CGFloat x0 = CGRectGetMinX(r), x1 = CGRectGetMaxX(r);
  CGFloat y0 = CGRectGetMinY(r), y1 = CGRectGetMaxY(r);
  CGFloat rad = MIN(radius, MIN(r.size.width, r.size.height) / 2.0);
  CGMutablePathRef p = CGPathCreateMutable();
  CGFloat sq = bottomIsMinY ? y1 : y0;  // square edge
  CGFloat rd = bottomIsMinY ? y0 : y1;  // rounded edge
  CGFloat dir = bottomIsMinY ? 1.0 : -1.0;
  CGPathMoveToPoint(p, NULL, x0, sq);
  CGPathAddLineToPoint(p, NULL, x1, sq);
  CGPathAddLineToPoint(p, NULL, x1, rd + rad * dir);
  CGPathAddArcToPoint(p, NULL, x1, rd, x1 - rad, rd, rad);
  CGPathAddLineToPoint(p, NULL, x0 + rad, rd);
  CGPathAddArcToPoint(p, NULL, x0, rd, x0, rd + rad * dir, rad);
  CGPathCloseSubpath(p);
  return p;
}

// setBottomCornerRadius(wid, radius) — clip any window's content view to a
// square-top / rounded-bottom shape via a CAShapeLayer mask (works for the web
// content AND the CAMetalLayer, which ignores an ancestor's cornerRadius). The
// caller re-invokes on resize with the new bounds. N-API runs on the AppKit
// main thread, so layer mutation here is safe.
Napi::Value SetBottomCornerRadius(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2) return env.Undefined();
  std::string widStr = info[0].ToString().Utf8Value();
  double radius = info[1].As<Napi::Number>().DoubleValue();
  uintptr_t ptr = static_cast<uintptr_t>(strtoull(widStr.c_str(), nullptr, 10));
  NSView* view = (__bridge NSView*)reinterpret_cast<void*>(ptr);
  if (!view) return env.Undefined();
  view.wantsLayer = YES;
  CALayer* layer = view.layer;
  if (!layer) return env.Undefined();
  CGPathRef path = CreateBottomRoundedPath(view.bounds, radius, !view.isFlipped);
  CAShapeLayer* mask = [layer.mask isKindOfClass:[CAShapeLayer class]]
                           ? (CAShapeLayer*)layer.mask
                           : [CAShapeLayer layer];
  [CATransaction begin];
  [CATransaction setDisableActions:YES];  // no implicit animation on resize
  mask.frame = view.bounds;
  mask.path = path;
  layer.mask = mask;
  [CATransaction commit];
  CGPathRelease(path);
  return env.Undefined();
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  // run.store(false) MUST stay first: a still-queued ApplyLayerColorConfig block
  // (posted from the event thread) is only safe because it early-returns on
  // !run, and it runs on this same main thread so it can't interleave with the
  // g_layer=nil below.
  g_state.run.store(false);
  // Wake + join the render thread BEFORE touching mpv/the layer: it does
  // rc_free with its own CGL context current, and frees the GL/IOSurface/Metal
  // objects itself. A render thread blocked in nextDrawable unblocks within the
  // 1s default allowsNextDrawableTimeout, bounding this join.
  {
    std::lock_guard<std::mutex> lk(g_state.wakeMutex);
    g_state.wake.store(true);
  }
  g_state.wakeCv.notify_all();
  if (g_state.renderThread.joinable()) g_state.renderThread.join();

  if (g_layer) [g_layer removeFromSuperlayer];
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
  if (g_state.mpv) {
    M::destroy(g_state.mpv);  // mpv_terminate_destroy — rc_free above already ran
    g_state.mpv = nullptr;
  }
  g_layer = nil;
  g_view = nil;
  g_device = nil;
  g_queue = nil;
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
  exports.Set("setBottomCornerRadius", Napi::Function::New(env, SetBottomCornerRadius));
  exports.Set("stop", Napi::Function::New(env, Stop));
  return exports;
}

}  // namespace

NODE_API_MODULE(fliks_player_mac, Init)
