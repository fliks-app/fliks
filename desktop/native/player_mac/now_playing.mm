// macOS Now Playing: MPNowPlayingInfoCenter (what the Control Center / lock screen show) and
// MPRemoteCommandCenter (media keys, headphones, Control Center buttons).
#import <Cocoa/Cocoa.h>
#import <MediaPlayer/MediaPlayer.h>
#include <napi.h>

namespace {

Napi::ThreadSafeFunction g_commandFn;
bool g_commandFnReady = false;
MPMediaItemArtwork* g_artwork = nil;
bool g_commandsOn = false;

// Next/previous are the client's +-10 s seek; scrubbing has no path through the client's seek flow, so it stays off.
void EnableCommands() {
  MPRemoteCommandCenter* c = [MPRemoteCommandCenter sharedCommandCenter];
  NSDictionary<NSString*, MPRemoteCommand*>* cmds = @{
    @"play": c.playCommand,
    @"pause": c.pauseCommand,
    @"toggle": c.togglePlayPauseCommand,
    @"stop": c.stopCommand,
    @"next": c.nextTrackCommand,
    @"previous": c.previousTrackCommand,
  };
  g_commandsOn = true;
  for (NSString* name in cmds) {
    MPRemoteCommand* cmd = cmds[name];
    cmd.enabled = YES;
    [cmd addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent*) {
      if (g_commandFnReady) {
        std::string s = [name UTF8String];
        g_commandFn.NonBlockingCall([s](Napi::Env env, Napi::Function fn) { fn.Call({Napi::String::New(env, s)}); });
      }
      return MPRemoteCommandHandlerStatusSuccess;
    }];
  }
  c.changePlaybackPositionCommand.enabled = NO;
  c.seekForwardCommand.enabled = NO;
  c.seekBackwardCommand.enabled = NO;
  c.skipForwardCommand.enabled = NO;
  c.skipBackwardCommand.enabled = NO;
}

void DisableCommands() {
  MPRemoteCommandCenter* c = [MPRemoteCommandCenter sharedCommandCenter];
  for (MPRemoteCommand* cmd in @[c.playCommand, c.pauseCommand, c.togglePlayPauseCommand, c.stopCommand,
                                 c.nextTrackCommand, c.previousTrackCommand]) {
    cmd.enabled = NO;
    [cmd removeTarget:nil];
  }
  g_commandsOn = false;
}

// onRemoteCommand(cb): cb receives play | pause | toggle | stop | next | previous.
Napi::Value OnRemoteCommand(const Napi::CallbackInfo& info) {
  if (g_commandFnReady) {
    g_commandFn.Release();
    g_commandFnReady = false;
  }
  g_commandFn = Napi::ThreadSafeFunction::New(info.Env(), info[0].As<Napi::Function>(), "nowPlayingCommand", 0, 1);
  g_commandFnReady = true;
  return info.Env().Undefined();
}

// setNowPlaying({title, artist?, artwork?: Buffer, duration, elapsed, playing}); artwork is kept until clearNowPlaying.
Napi::Value SetNowPlaying(const Napi::CallbackInfo& info) {
  Napi::Object o = info[0].As<Napi::Object>();
  if (!g_commandsOn) EnableCommands();
  if (o.Has("artwork") && o.Get("artwork").IsBuffer()) {
    Napi::Buffer<uint8_t> b = o.Get("artwork").As<Napi::Buffer<uint8_t>>();
    NSImage* img = [[NSImage alloc] initWithData:[NSData dataWithBytes:b.Data() length:b.Length()]];
    g_artwork = img ? [[MPMediaItemArtwork alloc] initWithBoundsSize:img.size
                                                       requestHandler:^NSImage*(CGSize) { return img; }]
                    : nil;
  }
  BOOL playing = o.Get("playing").ToBoolean().Value();
  NSMutableDictionary* d = [NSMutableDictionary dictionary];
  d[MPMediaItemPropertyTitle] = @(o.Get("title").ToString().Utf8Value().c_str());
  if (o.Has("artist")) d[MPMediaItemPropertyArtist] = @(o.Get("artist").ToString().Utf8Value().c_str());
  if (g_artwork) d[MPMediaItemPropertyArtwork] = g_artwork;
  d[MPMediaItemPropertyPlaybackDuration] = @(o.Get("duration").ToNumber().DoubleValue());
  d[MPNowPlayingInfoPropertyElapsedPlaybackTime] = @(o.Get("elapsed").ToNumber().DoubleValue());
  d[MPNowPlayingInfoPropertyPlaybackRate] = @(playing ? 1.0 : 0.0);
  d[MPNowPlayingInfoPropertyMediaType] = @(MPNowPlayingInfoMediaTypeVideo);
  MPNowPlayingInfoCenter* center = [MPNowPlayingInfoCenter defaultCenter];
  center.nowPlayingInfo = d;
  center.playbackState = playing ? MPNowPlayingPlaybackStatePlaying : MPNowPlayingPlaybackStatePaused;
  return info.Env().Undefined();
}

Napi::Value ClearNowPlaying(const Napi::CallbackInfo& info) {
  g_artwork = nil;
  MPNowPlayingInfoCenter* center = [MPNowPlayingInfoCenter defaultCenter];
  center.nowPlayingInfo = nil;
  center.playbackState = MPNowPlayingPlaybackStateStopped;
  if (g_commandsOn) DisableCommands();
  return info.Env().Undefined();
}

}  // namespace

void InitNowPlaying(Napi::Env env, Napi::Object exports) {
  exports.Set("onRemoteCommand", Napi::Function::New(env, OnRemoteCommand));
  exports.Set("setNowPlaying", Napi::Function::New(env, SetNowPlaying));
  exports.Set("clearNowPlaying", Napi::Function::New(env, ClearNowPlaying));
}
