// Windows System Media Transport Controls (the media overlay, lock screen and media keys) for the main
// window. Exposes the same setNowPlaying / clearNowPlaying / onRemoteCommand surface as the macOS addon.
#include <napi.h>

#include <windows.h>
#include <systemmediatransportcontrolsinterop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Media.h>
#include <winrt/Windows.Storage.Streams.h>

#include <chrono>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using namespace winrt;
using namespace winrt::Windows::Media;
using namespace winrt::Windows::Storage::Streams;

namespace {

SystemMediaTransportControls g_smtc{nullptr};
Napi::ThreadSafeFunction g_commandFn;
bool g_commandFnReady = false;

// Artwork requests apply on a worker thread: one is stale once a newer request, title change or clear has bumped the generation.
std::mutex g_artMutex;
uint64_t g_artGen = 0;
std::string g_title;

uint64_t NextArtGen() {
  std::lock_guard<std::mutex> lock(g_artMutex);
  return ++g_artGen;
}

void Emit(const char* name, double position = 0) {
  if (!g_commandFnReady) return;
  std::string s = name;
  g_commandFn.NonBlockingCall([s, position](Napi::Env env, Napi::Function fn) {
    fn.Call({Napi::String::New(env, s), Napi::Number::New(env, position)});
  });
}

// WinRT errors are not std::exception: hand them to JS, whose wrapper logs them.
template <class F>
Napi::Value Guard(const Napi::CallbackInfo& info, F f) {
  try {
    f();
  } catch (hresult_error const& e) {
    Napi::Error::New(info.Env(), to_string(e.message())).ThrowAsJavaScriptException();
  }
  return info.Env().Undefined();
}

Windows::Foundation::TimeSpan Seconds(double s) {
  return std::chrono::duration_cast<Windows::Foundation::TimeSpan>(std::chrono::duration<double>(s));
}

// attach(hwnd: Buffer): binds the controls to the window and routes the buttons to onRemoteCommand's callback.
Napi::Value Attach(const Napi::CallbackInfo& info) {
  return Guard(info, [&] {
  try {
    init_apartment(apartment_type::single_threaded);
  } catch (hresult_error const&) {  // Electron's main thread already initialised COM
  }
  Napi::Buffer<uint8_t> b = info[0].As<Napi::Buffer<uint8_t>>();
  HWND hwnd = *reinterpret_cast<HWND*>(b.Data());
  auto interop = get_activation_factory<SystemMediaTransportControls, ISystemMediaTransportControlsInterop>();
  check_hresult(interop->GetForWindow(hwnd, guid_of<SystemMediaTransportControls>(), put_abi(g_smtc)));
  g_smtc.ButtonPressed([](auto&&, SystemMediaTransportControlsButtonPressedEventArgs const& a) {
    switch (a.Button()) {
      case SystemMediaTransportControlsButton::Play: Emit("play"); break;
      case SystemMediaTransportControlsButton::Pause: Emit("pause"); break;
      case SystemMediaTransportControlsButton::Stop: Emit("stop"); break;
      case SystemMediaTransportControlsButton::Next: Emit("next"); break;
      case SystemMediaTransportControlsButton::Previous: Emit("previous"); break;
      default: break;
    }
  });
  g_smtc.PlaybackPositionChangeRequested([](auto&&, PlaybackPositionChangeRequestedEventArgs const& a) {
    Emit("seek", std::chrono::duration<double>(a.RequestedPlaybackPosition()).count());
  });
  g_smtc.IsEnabled(false);
  });
}

// onRemoteCommand(cb): cb receives play | pause | stop | next | previous, or seek with the position in seconds.
Napi::Value OnRemoteCommand(const Napi::CallbackInfo& info) {
  if (g_commandFnReady) {
    g_commandFn.Release();
    g_commandFnReady = false;
  }
  g_commandFn = Napi::ThreadSafeFunction::New(info.Env(), info[0].As<Napi::Function>(), "smtcCommand", 0, 1);
  g_commandFn.Unref(info.Env());
  g_commandFnReady = true;
  return info.Env().Undefined();
}

// Building the thumbnail stream awaits WinRT, so it runs off the JS thread.
void SetArtwork(std::vector<uint8_t> bytes, uint64_t gen) {
  std::thread([bytes = std::move(bytes), gen]() {
    try {
      init_apartment();
    } catch (...) {
      return;
    }
    try {
      InMemoryRandomAccessStream stream;
      DataWriter writer(stream);
      writer.WriteBytes(array_view<const uint8_t>(bytes.data(), bytes.data() + bytes.size()));
      writer.StoreAsync().get();
      writer.DetachStream();
      stream.Seek(0);
      std::lock_guard<std::mutex> lock(g_artMutex);
      if (gen == g_artGen) {
        auto updater = g_smtc.DisplayUpdater();
        updater.Thumbnail(Windows::Storage::Streams::RandomAccessStreamReference::CreateFromStream(stream));
        updater.Update();
      }
    } catch (...) {
    }
    uninit_apartment();
  }).detach();
}

// setNowPlaying({title, artist?, artwork?: Buffer, duration, elapsed, rate, playing}); artwork is kept until clearNowPlaying.
Napi::Value SetNowPlaying(const Napi::CallbackInfo& info) {
  return Guard(info, [&] {
  if (!g_smtc) return;
  Napi::Object o = info[0].As<Napi::Object>();
  bool playing = o.Get("playing").ToBoolean().Value();
  double duration = o.Get("duration").ToNumber().DoubleValue();
  double elapsed = o.Get("elapsed").ToNumber().DoubleValue();

  g_smtc.IsEnabled(true);
  g_smtc.IsPlayEnabled(true);
  g_smtc.IsPauseEnabled(true);
  g_smtc.IsStopEnabled(true);
  g_smtc.IsNextEnabled(true);
  g_smtc.IsPreviousEnabled(true);
  g_smtc.PlaybackRate(o.Get("rate").ToNumber().DoubleValue());
  g_smtc.PlaybackStatus(playing ? MediaPlaybackStatus::Playing : MediaPlaybackStatus::Paused);

  std::string title = o.Get("title").ToString().Utf8Value();
  uint64_t gen = 0;
  if (title != g_title || o.Get("artwork").IsBuffer()) gen = NextArtGen();
  g_title = title;

  auto updater = g_smtc.DisplayUpdater();
  updater.Type(MediaPlaybackType::Video);
  updater.VideoProperties().Title(to_hstring(title));
  if (o.Get("artist").IsString()) updater.VideoProperties().Subtitle(to_hstring(o.Get("artist").ToString().Utf8Value()));
  updater.Update();
  if (o.Get("artwork").IsBuffer()) {
    Napi::Buffer<uint8_t> a = o.Get("artwork").As<Napi::Buffer<uint8_t>>();
    SetArtwork(std::vector<uint8_t>(a.Data(), a.Data() + a.Length()), gen);
  }

  if (duration > 0) {
    SystemMediaTransportControlsTimelineProperties t;
    t.StartTime(Seconds(0));
    t.MinSeekTime(Seconds(0));
    t.EndTime(Seconds(duration));
    t.MaxSeekTime(Seconds(duration));
    t.Position(Seconds(elapsed));
    g_smtc.UpdateTimelineProperties(t);
  }
  });
}

Napi::Value ClearNowPlaying(const Napi::CallbackInfo& info) {
  return Guard(info, [&] {
    if (!g_smtc) return;
    NextArtGen();
    g_title.clear();
    g_smtc.PlaybackStatus(MediaPlaybackStatus::Stopped);
    g_smtc.DisplayUpdater().ClearAll();
    g_smtc.IsEnabled(false);
  });
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("attach", Napi::Function::New(env, Attach));
  exports.Set("onRemoteCommand", Napi::Function::New(env, OnRemoteCommand));
  exports.Set("setNowPlaying", Napi::Function::New(env, SetNowPlaying));
  exports.Set("clearNowPlaying", Napi::Function::New(env, ClearNowPlaying));
  return exports;
}

}  // namespace

NODE_API_MODULE(fliks_smtc_win, Init)
