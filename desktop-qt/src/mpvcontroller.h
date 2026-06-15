#pragma once

// Drives an mpv subprocess that renders into a nested Wayland compositor
// surface, controlled over mpv's JSON IPC. Exposes the exact FliksDesktopApi
// slots/signals the Angular client drives via QtWebChannel — same contract as
// the libmpv MpvObject it replaces, so the bridge shim is unchanged. The video
// lives on a separate Wayland surface (outside the QtQuick scene graph) so the
// transparent WebEngineView never composites over an in-scene video texture,
// which is what triggers QtWebEngine's transparent ghosting (QTBUG-111739).
#include <QObject>
#include <QString>
#include <QByteArray>
#include <QJsonArray>
#include <QJsonObject>
#include <QJsonValue>

class QProcess;
class QLocalSocket;

class MpvController : public QObject {
    Q_OBJECT
    Q_PROPERTY(QString socketName READ socketName CONSTANT)

public:
    explicit MpvController(QObject *parent = nullptr);
    ~MpvController() override;

    QString socketName() const { return m_socketName; }

public slots:
    void start();                          // launch mpv once the compositor listens
    // ── FliksDesktopApi surface (invoked from JS via QWebChannel) ──
    void load(const QString &optsJson);    // DesktopLoadOptions JSON
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
    void setGeometry(int width, int height);      // mirror the window size to mpv

signals:
    void desktopEvent(const QString &json); // DesktopEvent JSON → JS
    void fullscreenRequested(bool enabled); // handled by the Window in QML

private slots:
    void tryConnectIpc();
    void onIpcReadyRead();

private:
    void cmd(const QJsonArray &command);
    void setProp(const QString &name, const QJsonValue &value);
    void emitDesktop(const QJsonObject &event);
    void handleEvent(const QJsonObject &ev);
    void handlePropertyChange(const QString &name, const QJsonValue &data);
    void rebuildTracks(const QJsonArray &trackList);
    void emitState();

    QString m_socketName;     // nested-compositor Wayland socket mpv connects to
    QString m_ipcPath;        // mpv JSON IPC unix socket
    QProcess *m_proc = nullptr;
    QLocalSocket *m_ipc = nullptr;
    QByteArray m_rx;
    QString m_pendingLoad;    // load() arrived before the IPC was up
    bool m_stopped = false;
    bool m_firstFrameSent = false;
    double m_pos = 0.0, m_dur = 0.0, m_cache = 0.0;
    bool m_paused = true, m_idle = true;
    QJsonArray m_audioTracks, m_subTracks;
    int m_width = 1280, m_height = 800;
};
