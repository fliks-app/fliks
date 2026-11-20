// Whether macOS lets this app show notifications; Electron exposes no such read.
#include <napi.h>
#import <UserNotifications/UserNotifications.h>

namespace {

// "allowed", "denied" or "undetermined" (macOS asks on the first notification).
Napi::Value NotifyAuthorization(const Napi::CallbackInfo& info) {
  __block UNAuthorizationStatus status = UNAuthorizationStatusNotDetermined;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  [[UNUserNotificationCenter currentNotificationCenter] getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* s) {
    status = s.authorizationStatus;
    dispatch_semaphore_signal(done);
  }];
  // The handler runs on a background queue; a stuck daemon must not freeze the main process.
  if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)) != 0) {
    return Napi::String::New(info.Env(), "undetermined");
  }
  const char* out = status == UNAuthorizationStatusDenied ? "denied"
                    : status == UNAuthorizationStatusNotDetermined ? "undetermined"
                                                                     : "allowed";
  return Napi::String::New(info.Env(), out);
}

}  // namespace

void InitNotifyStatus(Napi::Env env, Napi::Object exports) {
  exports.Set("notifyAuthorization", Napi::Function::New(env, NotifyAuthorization));
}
