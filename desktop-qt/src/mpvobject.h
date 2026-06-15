#pragma once

// libmpv rendered into a QtQuick scene-graph FBO (mpv's qt_opengl pattern),
// plus the full FliksDesktopApi player surface so the Angular client drives it
// over QtWebChannel exactly as it drives the Electron preload / Capacitor
// NativePlayer. Method args + returns are JSON strings (robust over WebChannel).
#include <QtQuick/QQuickFramebufferObject>
#include <QString>
#include <QStringList>
#include <mpv/client.h>
#include <mpv/render_gl.h>

class MpvObject : public QQuickFramebufferObject {
    Q_OBJECT

public:
    explicit MpvObject(QQuickItem *parent = nullptr);
    ~MpvObject() override;

    Renderer *createRenderer() const override;
    mpv_handle *handle() const { return mpv; }

public slots:
    // ── FliksDesktopApi surface (invoked from JS via QWebChannel) ──
    void load(const QString &optsJson);   // DesktopLoadOptions JSON
    void play();
    void pause();
    void seekTo(double position);
    void stop();
    void setPlaybackRate(double rate);
    void setVolume(double volume);
    void setMuted(bool muted);
    void setFullscreen(bool enabled);
    QString getPosition();                 // DesktopPositionInfo JSON
    QString getAudioTracks();              // DesktopAudioTrack[] JSON
    QString getSubtitleTracks();           // DesktopSubtitleTrack[] JSON
    void selectAudioTrack(const QString &id);
    void selectSubtitleTrack(const QString &id);  // "" / "null" → off
    void setSubtitleStyle(const QString &styleJson);
    void destroyPlayer();

signals:
    void onUpdate();                        // mpv render thread → repaint
    void desktopEvent(const QString &json); // DesktopEvent JSON → JS
    void fullscreenRequested(bool enabled); // handled by the Window in QML

private slots:
    void doUpdate();
    void onRenderReady();
    void onMpvEvents();                     // drain mpv queue on the GUI thread

private:
    void command(const QStringList &args);
    void setOpt(const char *name, const QString &value);
    void emitDesktop(const QString &json);
    void handleMpvEvent(mpv_event *ev);
    QString trackListJson(bool subtitles);

    mpv_handle *mpv = nullptr;
    QString m_pendingFile;
    bool m_renderReady = false;
    bool m_firstFrameSent = false;
    double m_duration = 0.0;
    friend class MpvRenderer;
};
