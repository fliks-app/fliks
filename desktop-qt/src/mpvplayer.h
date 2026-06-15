#pragma once

// In-process libmpv driving the FliksDesktopApi, rendering via mpv's GL render
// API into an EGL window surface backed by a Wayland SUBSURFACE placed below the
// transparent Qt window. The web UI (transparent WebEngineView) is the only
// thing in the QtQuick scene, so it composites over nothing — sidestepping
// QtWebEngine's transparent ghosting (QTBUG-111739) entirely. mpv uses vo=libmpv
// (never its own Wayland VO), so it doesn't bind wl_seat (no Qt 6.8 abort).
//
// Same slots/signals as the Angular client expects over QtWebChannel.
#include <QObject>
#include <QString>
#include <QStringList>
#include <mpv/client.h>
#include <mpv/render_gl.h>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <atomic>

struct wl_display;
struct wl_surface;
struct wl_egl_window;

class MpvPlayer : public QObject {
    Q_OBJECT

public:
    explicit MpvPlayer(QObject *parent = nullptr);
    ~MpvPlayer() override;

    // Wire mpv rendering to a Wayland subsurface (called from main once the
    // subsurface exists). Spawns the render thread that owns the EGL context.
    void initRender(wl_display *display, wl_surface *surface, int w, int h);
    void resizeSurface(int w, int h);

public slots:
    void load(const QString &optsJson);
    void play();
    void pause();
    void seekTo(double position);
    void stop();
    void setPlaybackRate(double rate);
    void setVolume(double volume);
    void setMuted(bool muted);
    void setFullscreen(bool enabled);
    QString getPosition();
    QString getAudioTracks();
    QString getSubtitleTracks();
    void selectAudioTrack(const QString &id);
    void selectSubtitleTrack(const QString &id);
    void setSubtitleStyle(const QString &styleJson);
    void destroyPlayer();

signals:
    void desktopEvent(const QString &json);
    void fullscreenRequested(bool enabled);

private slots:
    void onMpvEvents();   // drain mpv queue on the GUI thread

private:
    void command(const QStringList &args);
    void setOpt(const char *name, const QString &value);
    void emitDesktop(const QString &json);
    void handleMpvEvent(mpv_event *ev);
    QString trackListJson(bool subtitles);
    void renderThreadFunc();

    mpv_handle *mpv = nullptr;
    mpv_render_context *m_render = nullptr;

    // Wayland / EGL (opaque void* so the header stays EGL-free).
    wl_display *m_wlDisplay = nullptr;
    wl_surface *m_wlSurface = nullptr;
    wl_egl_window *m_eglWindow = nullptr;
    void *m_eglDisplay = nullptr;
    void *m_eglContext = nullptr;
    void *m_eglSurface = nullptr;

    std::thread m_renderThread;
    std::mutex m_mtx;
    std::condition_variable m_cv;
    std::atomic<bool> m_running{false};
    std::atomic<bool> m_wantRedraw{false};
    std::atomic<bool> m_wantResize{false};
    std::atomic<int> m_w{1280};
    std::atomic<int> m_h{800};

    bool m_firstFrameSent = false;
    double m_duration = 0.0;
};
