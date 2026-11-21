// Live full-screen transitions: the window animates its own frame, so the page and the video keep
// drawing, instead of AppKit's cross-fade of two snapshots taken before either can redraw.

#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>

#include <napi.h>

#include <cstdio>
#include <cstdlib>

namespace {

const char kWindowedFrameKey = 0;

// Reduce Motion keeps AppKit's own cross-fade.
NSArray* CustomWindowsToEnter(id, SEL, NSWindow* window) {
  return NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion ? nil : @[ window ];
}

NSArray* CustomWindowsToExit(id, SEL, NSWindow* window) {
  return objc_getAssociatedObject(window, &kWindowedFrameKey) ? @[ window ] : nil;
}

// The saved frame, or its size centred on the window's screen when its display has gone.
NSRect RestoredFrame(NSWindow* window, NSRect saved) {
  for (NSScreen* screen in NSScreen.screens)
    if (NSIntersectsRect(screen.visibleFrame, saved)) return saved;
  const NSRect v = (window.screen ?: NSScreen.mainScreen).visibleFrame;
  const NSSize size = NSMakeSize(MIN(saved.size.width, v.size.width), MIN(saved.size.height, v.size.height));
  return NSMakeRect(NSMidX(v) - size.width / 2, NSMidY(v) - size.height / 2, size.width, size.height);
}

void AnimateFrame(NSWindow* window, NSRect frame, NSTimeInterval duration) {
  [NSAnimationContext
      runAnimationGroup:^(NSAnimationContext* context) {
        context.duration = duration;
        [window.animator setFrame:frame display:YES];
      }
      completionHandler:nil];
}

void StartEnter(id, SEL, NSWindow* window, NSTimeInterval duration) {
  const NSRect windowed = window.frame;
  objc_setAssociatedObject(window, &kWindowedFrameKey, [NSValue valueWithRect:windowed],
                           OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  window.styleMask |= NSWindowStyleMaskFullScreen;
  [window setFrame:windowed display:YES];  // the style change alone would jump the window
  NSScreen* screen = window.screen ?: NSScreen.mainScreen;
  NSRect full = screen.frame;
  full.size.height -= screen.safeAreaInsets.top;  // below the camera housing, as AppKit places it
  AnimateFrame(window, full, duration);
}

void StartExit(id, SEL, NSWindow* window, NSTimeInterval duration) {
  NSValue* saved = objc_getAssociatedObject(window, &kWindowedFrameKey);
  objc_setAssociatedObject(window, &kWindowedFrameKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  window.styleMask &= ~NSWindowStyleMaskFullScreen;
  AnimateFrame(window, RestoredFrame(window, saved.rectValue), duration);
}

// useLiveFullscreen(wid): wid is the decimal pointer to the window's content NSView.
Napi::Value UseLiveFullscreen(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1) return env.Undefined();
  const uintptr_t ptr = std::strtoull(info[0].ToString().Utf8Value().c_str(), nullptr, 10);
  NSWindow* window = ((__bridge NSView*)reinterpret_cast<void*>(ptr)).window;
  if (!window.delegate) return env.Undefined();
  // Electron's delegate implements none of these, so they are added, not overridden.
  Class cls = object_getClass(window.delegate);
  auto add = [cls](SEL sel, IMP imp, const char* types) {
    if (!class_addMethod(cls, sel, imp, types) && imp != class_getMethodImplementation(cls, sel))
      fprintf(stderr, "[player-mac] window delegate already implements %s\n", sel_getName(sel));
  };
  add(@selector(customWindowsToEnterFullScreenForWindow:), (IMP)CustomWindowsToEnter, "@@:@");
  add(@selector(customWindowsToExitFullScreenForWindow:), (IMP)CustomWindowsToExit, "@@:@");
  add(@selector(window:startCustomAnimationToEnterFullScreenWithDuration:), (IMP)StartEnter, "v@:@d");
  add(@selector(window:startCustomAnimationToExitFullScreenWithDuration:), (IMP)StartExit, "v@:@d");
  return env.Undefined();
}

}  // namespace

void InitLiveFullscreen(Napi::Env env, Napi::Object exports) {
  exports.Set("useLiveFullscreen", Napi::Function::New(env, UseLiveFullscreen));
}
