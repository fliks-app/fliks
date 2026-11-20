// Whether macOS lets this app show notifications; Electron exposes no such read.
#include <napi.h>
#import <UserNotifications/UserNotifications.h>

#include <memory>
#include <string>

namespace {

// Resolves "allowed", "denied" or "undetermined" (macOS asks on the first notification).
Napi::Value NotifyAuthorization(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto deferred = std::make_shared<Napi::Promise::Deferred>(Napi::Promise::Deferred::New(env));
  auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function::New(env, [](const Napi::CallbackInfo&) {}),
                                            "notifyAuthorization", 0, 1);
  [[UNUserNotificationCenter currentNotificationCenter] getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* s) {
    std::string out = s.authorizationStatus == UNAuthorizationStatusDenied          ? "denied"
                      : s.authorizationStatus == UNAuthorizationStatusNotDetermined ? "undetermined"
                                                                                    : "allowed";
    Napi::ThreadSafeFunction fn = tsfn;
    fn.BlockingCall([deferred, out](Napi::Env env, Napi::Function) { deferred->Resolve(Napi::String::New(env, out)); });
    fn.Release();
  }];
  return deferred->Promise();
}

}  // namespace

void InitNotifyStatus(Napi::Env env, Napi::Object exports) {
  exports.Set("notifyAuthorization", Napi::Function::New(env, NotifyAuthorization));
}
