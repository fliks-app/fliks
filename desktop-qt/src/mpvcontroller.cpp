#include "mpvcontroller.h"

#include <QProcess>
#include <QLocalSocket>
#include <QProcessEnvironment>
#include <QCoreApplication>
#include <QJsonDocument>
#include <QTimer>
#include <QFile>

namespace {
QString compact(const QJsonObject &o) {
    return QString::fromUtf8(QJsonDocument(o).toJson(QJsonDocument::Compact));
}
QString compact(const QJsonArray &a) {
    return QString::fromUtf8(QJsonDocument(a).toJson(QJsonDocument::Compact));
}

// CSS color → mpv color (#AARRGGBB). mpv rejects "transparent"/"rgba(...)";
// the client emits CSS colour strings for subtitle styling.
QString mpvColor(const QString &css) {
    const QString c = css.trimmed().toLower();
    if (c.isEmpty() || c == QLatin1String("transparent"))
        return QStringLiteral("#00000000");
    if (c.startsWith(QLatin1String("rgba(")) || c.startsWith(QLatin1String("rgb("))) {
        const int lp = c.indexOf('('), rp = c.indexOf(')');
        const QStringList p = c.mid(lp + 1, rp - lp - 1).split(',', Qt::SkipEmptyParts);
        if (p.size() >= 3) {
            const int r = p[0].trimmed().toInt();
            const int g = p[1].trimmed().toInt();
            const int b = p[2].trimmed().toInt();
            const int a = p.size() >= 4
                ? qBound(0, qRound(p[3].trimmed().toDouble() * 255.0), 255) : 255;
            return QStringLiteral("#%1%2%3%4")
                .arg(a, 2, 16, QLatin1Char('0')).arg(r, 2, 16, QLatin1Char('0'))
                .arg(g, 2, 16, QLatin1Char('0')).arg(b, 2, 16, QLatin1Char('0'));
        }
    }
    return css; // #RRGGBB / #AARRGGBB / mpv-recognised name passes through
}
} // namespace

MpvController::MpvController(QObject *parent) : QObject(parent) {
    const qint64 pid = QCoreApplication::applicationPid();
    m_socketName = QStringLiteral("fliks-mpv-%1").arg(pid);
    m_ipcPath = QStringLiteral("/tmp/fliks-mpv-ipc-%1.sock").arg(pid);
}

MpvController::~MpvController() {
    m_stopped = true;
    if (m_ipc && m_ipc->state() == QLocalSocket::ConnectedState) {
        cmd(QJsonArray{QStringLiteral("quit")});
        m_ipc->flush();
    }
    if (m_proc) {
        m_proc->terminate();
        if (!m_proc->waitForFinished(1000)) m_proc->kill();
    }
    QFile::remove(m_ipcPath);
}

void MpvController::start() {
    if (m_proc) return;
    QFile::remove(m_ipcPath);
    m_proc = new QProcess(this);
    m_proc->setProcessChannelMode(QProcess::MergedChannels);
    m_proc->setStandardOutputFile(QStringLiteral("/tmp/mpv-out.log"));
    connect(m_proc, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished),
            this, [](int code, QProcess::ExitStatus st) {
                qWarning("[mpv-proc] exited code=%d status=%d", code, st);
            });
    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert(QStringLiteral("WAYLAND_DISPLAY"), m_socketName); // connect to OUR compositor
    // Don't leak the host app's Qt runtime into mpv — its LD_LIBRARY_PATH /
    // plugin paths point at the bundled Qt libs (libav*, libwayland, …) and the
    // system mpv binary aborts (SIGABRT) when it loads those instead of its own.
    env.remove(QStringLiteral("LD_LIBRARY_PATH"));
    env.remove(QStringLiteral("QT_PLUGIN_PATH"));
    env.remove(QStringLiteral("QML2_IMPORT_PATH"));
    env.remove(QStringLiteral("QML_IMPORT_PATH"));
    env.remove(QStringLiteral("QT_QPA_PLATFORM"));
    m_proc->setProcessEnvironment(env);
    // mpv >= 0.38 required (0.37 aborts on Qt 6.8's wl_seat.name event — Qt
    // QTBUG-129203). FLIKS_MPV_BIN overrides the binary (e.g. a bundled mpv).
    const QByteArray mpvBin = qgetenv("FLIKS_MPV_BIN");

    const QStringList args{
        QStringLiteral("--idle=yes"),               // stay alive; play via IPC loadfile
        QStringLiteral("--force-window=yes"),        // create the surface immediately
        QStringLiteral("--no-config"),
        QStringLiteral("--no-osc"),                  // the Angular UI is the OSD
        QStringLiteral("--osd-level=0"),
        QStringLiteral("--no-input-default-bindings"),
        QStringLiteral("--input-vo-keyboard=no"),
        QStringLiteral("--cursor-autohide=no"),
        QStringLiteral("--keep-open=yes"),
        QStringLiteral("--force-seekable=yes"),
        QStringLiteral("--hwdec=auto-copy"),
        QStringLiteral("--vo=wlshm"),                // software Wayland-shm output
        QStringLiteral("--vf=format=fmt=bgr0"),
        QStringLiteral("--geometry=%1x%2").arg(m_width).arg(m_height),
        QStringLiteral("--demuxer-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=5"),
        QStringLiteral("--input-ipc-server=%1").arg(m_ipcPath),
    };
    m_proc->start(mpvBin.isEmpty() ? QStringLiteral("mpv") : QString::fromUtf8(mpvBin), args);
    QTimer::singleShot(300, this, &MpvController::tryConnectIpc);
}

void MpvController::tryConnectIpc() {
    if (m_stopped) return;
    if (!m_ipc) {
        m_ipc = new QLocalSocket(this);
        connect(m_ipc, &QLocalSocket::readyRead, this, &MpvController::onIpcReadyRead);
    }
    if (m_ipc->state() == QLocalSocket::ConnectedState) return;
    m_ipc->connectToServer(m_ipcPath);
    if (m_ipc->waitForConnected(500)) {
        cmd({QStringLiteral("observe_property"), 1, QStringLiteral("time-pos")});
        cmd({QStringLiteral("observe_property"), 2, QStringLiteral("duration")});
        cmd({QStringLiteral("observe_property"), 3, QStringLiteral("pause")});
        cmd({QStringLiteral("observe_property"), 4, QStringLiteral("core-idle")});
        cmd({QStringLiteral("observe_property"), 5, QStringLiteral("track-list")});
        cmd({QStringLiteral("observe_property"), 6, QStringLiteral("demuxer-cache-time")});
        emitDesktop({{"type", "ready"}});
        if (!m_pendingLoad.isEmpty()) {
            const QString p = m_pendingLoad;
            m_pendingLoad.clear();
            load(p);
        }
    } else if (!m_stopped) {
        QTimer::singleShot(200, this, &MpvController::tryConnectIpc);
    }
}

// ── IPC plumbing ──
void MpvController::cmd(const QJsonArray &command) {
    if (!m_ipc || m_ipc->state() != QLocalSocket::ConnectedState) return;
    const QJsonObject msg{{"command", command}};
    m_ipc->write(QJsonDocument(msg).toJson(QJsonDocument::Compact) + "\n");
    m_ipc->flush();
}

void MpvController::setProp(const QString &name, const QJsonValue &value) {
    cmd({QStringLiteral("set_property"), name, value});
}

void MpvController::emitDesktop(const QJsonObject &event) { emit desktopEvent(compact(event)); }

void MpvController::onIpcReadyRead() {
    m_rx += m_ipc->readAll();
    int nl;
    while ((nl = m_rx.indexOf('\n')) >= 0) {
        const QByteArray line = m_rx.left(nl);
        m_rx.remove(0, nl + 1);
        if (line.trimmed().isEmpty()) continue;
        const QJsonObject obj = QJsonDocument::fromJson(line).object();
        if (obj.contains(QLatin1String("event"))) handleEvent(obj);
        // request_id responses are unused — all state arrives via observed props.
    }
}

void MpvController::handleEvent(const QJsonObject &ev) {
    const QString name = ev.value(QStringLiteral("event")).toString();
    if (name == QLatin1String("property-change")) {
        handlePropertyChange(ev.value(QStringLiteral("name")).toString(),
                             ev.value(QStringLiteral("data")));
    } else if (name == QLatin1String("end-file")) {
        const QString reason = ev.value(QStringLiteral("reason")).toString();
        if (reason == QLatin1String("error")) {
            emitDesktop({{"type", "error"},
                         {"payload", QJsonObject{
                             {"message", ev.value(QStringLiteral("file_error"))
                                            .toString(QStringLiteral("playback error"))}}}});
        } else if (reason == QLatin1String("eof")) {
            emitDesktop({{"type", "stateChanged"},
                         {"payload", QJsonObject{{"state", "ended"}}}});
        }
    }
}

void MpvController::handlePropertyChange(const QString &name, const QJsonValue &data) {
    if (name == QLatin1String("time-pos")) {
        m_pos = data.toDouble();
        emitDesktop({{"type", "timeUpdate"},
                     {"payload", QJsonObject{{"position", m_pos},
                                             {"duration", m_dur},
                                             {"buffered", m_cache}}}});
        if (!m_firstFrameSent && m_pos >= 0) {
            m_firstFrameSent = true;
            emitDesktop({{"type", "firstFrame"}});
        }
    } else if (name == QLatin1String("duration")) {
        m_dur = data.toDouble();
    } else if (name == QLatin1String("demuxer-cache-time")) {
        m_cache = data.toDouble();
    } else if (name == QLatin1String("pause")) {
        m_paused = data.toBool();
        emitState();
    } else if (name == QLatin1String("core-idle")) {
        m_idle = data.toBool();
        emitState();
    } else if (name == QLatin1String("track-list")) {
        rebuildTracks(data.toArray());
        emitDesktop({{"type", "tracksChanged"},
                     {"payload", QJsonObject{{"audioTracks", m_audioTracks},
                                             {"subtitleTracks", m_subTracks}}}});
    }
}

void MpvController::emitState() {
    const char *state = m_paused ? "paused" : (m_idle ? "buffering" : "playing");
    emitDesktop({{"type", "stateChanged"}, {"payload", QJsonObject{{"state", state}}}});
}

void MpvController::rebuildTracks(const QJsonArray &trackList) {
    m_audioTracks = QJsonArray();
    m_subTracks = QJsonArray();
    for (const QJsonValue &tv : trackList) {
        const QJsonObject t = tv.toObject();
        const QString type = t.value(QStringLiteral("type")).toString();
        const QString id = QString::number(t.value(QStringLiteral("id")).toInt());
        const QString lang = t.value(QStringLiteral("lang")).toString();
        const QString title = t.value(QStringLiteral("title")).toString();
        const bool selected = t.value(QStringLiteral("selected")).toBool();
        QJsonObject e{{"id", id},
                      {"language", lang},
                      {"label", title.isEmpty() ? lang : title},
                      {"selected", selected}};
        if (type == QLatin1String("audio")) {
            m_audioTracks.append(e);
        } else if (type == QLatin1String("sub")) {
            e.insert(QStringLiteral("forced"), false);
            m_subTracks.append(e);
        }
    }
}

// ── FliksDesktopApi surface ──
void MpvController::load(const QString &optsJson) {
    if (!m_ipc || m_ipc->state() != QLocalSocket::ConnectedState) {
        m_pendingLoad = optsJson; // replay once the IPC connects
        return;
    }
    const QJsonObject o = QJsonDocument::fromJson(optsJson.toUtf8()).object();
    const QString url = o.value(QStringLiteral("url")).toString();
    if (url.isEmpty()) return;
    m_firstFrameSent = false;

    // Auth/other headers → mpv http-header-fields ("Key: Value" list). Set
    // before loadfile so the request carries them.
    if (o.value(QStringLiteral("headers")).isObject()) {
        const QJsonObject h = o.value(QStringLiteral("headers")).toObject();
        QJsonArray hdr;
        for (auto it = h.begin(); it != h.end(); ++it)
            hdr.append(it.key() + QStringLiteral(": ") + it.value().toString());
        setProp(QStringLiteral("http-header-fields"), hdr);
    }

    QString opts;
    if (o.contains(QStringLiteral("startTime"))) {
        const double t = o.value(QStringLiteral("startTime")).toDouble();
        if (t > 0) opts = QStringLiteral("start=%1").arg(t, 0, 'f', 3);
    }
    // mpv >= 0.38 loadfile: <url> <flags> <index> <options> (the index arg was
    // added in 0.38; we require >= 0.38 — see start()). index 0 = play now.
    QJsonArray lf{QStringLiteral("loadfile"), url, QStringLiteral("replace"), 0};
    if (!opts.isEmpty()) lf.append(opts);
    cmd(lf);

    for (const QJsonValue &sv : o.value(QStringLiteral("subtitles")).toArray()) {
        const QJsonObject s = sv.toObject();
        const QString surl = s.value(QStringLiteral("url")).toString();
        if (!surl.isEmpty())
            cmd({QStringLiteral("sub-add"), surl, QStringLiteral("auto"),
                 s.value(QStringLiteral("label")).toString(),
                 s.value(QStringLiteral("language")).toString()});
    }
}

void MpvController::play() { setProp(QStringLiteral("pause"), false); }
void MpvController::pause() { setProp(QStringLiteral("pause"), true); }
void MpvController::seekTo(double position) {
    cmd({QStringLiteral("seek"), position, QStringLiteral("absolute")});
}
void MpvController::stop() { cmd(QJsonArray{QStringLiteral("stop")}); }
void MpvController::setPlaybackRate(double rate) { setProp(QStringLiteral("speed"), rate); }
void MpvController::setVolume(double volume) { setProp(QStringLiteral("volume"), volume); }
void MpvController::setMuted(bool muted) { setProp(QStringLiteral("mute"), muted); }
void MpvController::setFullscreen(bool enabled) { emit fullscreenRequested(enabled); }

void MpvController::selectAudioTrack(const QString &id) {
    setProp(QStringLiteral("aid"), id.isEmpty() ? QStringLiteral("auto") : id);
}
void MpvController::selectSubtitleTrack(const QString &id) {
    setProp(QStringLiteral("sid"),
            (id.isEmpty() || id == QLatin1String("null")) ? QStringLiteral("no") : id);
}

void MpvController::setSubtitleStyle(const QString &styleJson) {
    const QJsonObject s = QJsonDocument::fromJson(styleJson.toUtf8()).object();
    if (s.contains(QStringLiteral("fontScale")))
        setProp(QStringLiteral("sub-scale"), s.value(QStringLiteral("fontScale")).toDouble());
    if (s.contains(QStringLiteral("foregroundColor")))
        setProp(QStringLiteral("sub-color"), mpvColor(s.value(QStringLiteral("foregroundColor")).toString()));
    if (s.contains(QStringLiteral("backgroundColor")))
        setProp(QStringLiteral("sub-back-color"), mpvColor(s.value(QStringLiteral("backgroundColor")).toString()));
    if (s.contains(QStringLiteral("bottomMarginPercent")))
        setProp(QStringLiteral("sub-pos"), 100.0 - s.value(QStringLiteral("bottomMarginPercent")).toDouble());
}

void MpvController::destroyPlayer() { cmd(QJsonArray{QStringLiteral("stop")}); }

void MpvController::setGeometry(int width, int height) {
    m_width = width;
    m_height = height;
    setProp(QStringLiteral("geometry"), QStringLiteral("%1x%2").arg(width).arg(height));
}

QString MpvController::getPosition() {
    return compact(QJsonObject{{"position", m_pos}, {"duration", m_dur}, {"buffered", m_cache}});
}
QString MpvController::getAudioTracks() { return compact(m_audioTracks); }
QString MpvController::getSubtitleTracks() { return compact(m_subTracks); }
