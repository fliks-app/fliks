#include "mpvobject.h"

#include <QtGui/QOpenGLContext>
#include <QtOpenGL/QOpenGLFramebufferObject>
#include <QtQuick/QQuickWindow>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QMetaObject>
#include <clocale>
#include <stdexcept>

namespace {
void *get_proc_address(void *, const char *name) {
    QOpenGLContext *ctx = QOpenGLContext::currentContext();
    if (!ctx) return nullptr;
    return reinterpret_cast<void *>(ctx->getProcAddress(QByteArray(name)));
}

QString jsonStr(const QJsonObject &o) {
    return QString::fromUtf8(QJsonDocument(o).toJson(QJsonDocument::Compact));
}

// CSS color → mpv color (#AARRGGBB). mpv rejects "transparent"/"rgba(...)";
// the client emits CSS colour strings for subtitle styling.
QString mpvColor(const QString &css) {
    const QString c = css.trimmed().toLower();
    if (c.isEmpty() || c == QLatin1String("transparent"))
        return QStringLiteral("#00000000");
    if (c.startsWith(QLatin1String("rgba(")) || c.startsWith(QLatin1String("rgb("))) {
        const QString inner = c.mid(c.indexOf('(') + 1, c.indexOf(')') - c.indexOf('(') - 1);
        const QStringList p = inner.split(',', Qt::SkipEmptyParts);
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

// ── Renderer: scene-graph render thread ──
class MpvRenderer : public QQuickFramebufferObject::Renderer {
    MpvObject *obj;
    mpv_render_context *mpv_gl = nullptr;

public:
    explicit MpvRenderer(MpvObject *o) : obj(o) {}
    ~MpvRenderer() override {
        if (mpv_gl) mpv_render_context_free(mpv_gl);
    }

    void ensureContext() {
        if (mpv_gl) return;
        mpv_opengl_init_params gl_init{};
        gl_init.get_proc_address = get_proc_address;
        mpv_render_param params[]{
            {MPV_RENDER_PARAM_API_TYPE, const_cast<char *>(MPV_RENDER_API_TYPE_OPENGL)},
            {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl_init},
            {MPV_RENDER_PARAM_INVALID, nullptr},
        };
        if (mpv_render_context_create(&mpv_gl, obj->mpv, params) < 0)
            throw std::runtime_error("failed to create mpv render context");
        mpv_render_context_set_update_callback(
            mpv_gl,
            [](void *ctx) { emit static_cast<MpvObject *>(ctx)->onUpdate(); },
            obj);
        QMetaObject::invokeMethod(obj, "onRenderReady", Qt::QueuedConnection);
    }

    QOpenGLFramebufferObject *createFramebufferObject(const QSize &size) override {
        ensureContext();
        return new QOpenGLFramebufferObject(size);
    }

    void render() override {
        static int frames = 0;
        if (++frames % 60 == 1)
            qWarning("[mpv-render] frame %d", frames);
        QOpenGLFramebufferObject *fbo = framebufferObject();
        mpv_opengl_fbo mpfbo{static_cast<int>(fbo->handle()),
                             fbo->width(), fbo->height(), 0};
        int flip_y = 0; // QtQuick composites this FBO top-down already
        mpv_render_param params[]{
            {MPV_RENDER_PARAM_OPENGL_FBO, &mpfbo},
            {MPV_RENDER_PARAM_FLIP_Y, &flip_y},
            {MPV_RENDER_PARAM_INVALID, nullptr},
        };
        mpv_render_context_render(mpv_gl, params);
    }
};

// ── MpvObject: GUI thread ──
MpvObject::MpvObject(QQuickItem *parent) : QQuickFramebufferObject(parent) {
    mpv = mpv_create();
    if (!mpv) throw std::runtime_error("mpv_create failed");
    mpv_set_option_string(mpv, "terminal", "yes");
    mpv_set_option_string(mpv, "msg-level", "all=v");
    mpv_set_option_string(mpv, "vo", "libmpv");
    mpv_set_option_string(mpv, "hwdec", "auto-copy");
    mpv_set_option_string(mpv, "keep-open", "yes");
    mpv_set_option_string(mpv, "force-seekable", "yes");
    // mpv's ffmpeg HLS demuxer reconnects on transient 4xx/5xx (resume into a
    // transcode races the playlist) — mirrors the Electron addon.
    mpv_set_option_string(mpv, "demuxer-lavf-o",
                          "reconnect=1,reconnect_streamed=1,reconnect_delay_max=5");
    if (mpv_initialize(mpv) < 0) throw std::runtime_error("mpv_initialize failed");

    mpv_observe_property(mpv, 0, "time-pos", MPV_FORMAT_DOUBLE);
    mpv_observe_property(mpv, 0, "duration", MPV_FORMAT_DOUBLE);
    mpv_observe_property(mpv, 0, "pause", MPV_FORMAT_FLAG);
    mpv_observe_property(mpv, 0, "core-idle", MPV_FORMAT_FLAG);
    mpv_observe_property(mpv, 0, "track-list", MPV_FORMAT_NONE);

    mpv_set_wakeup_callback(
        mpv,
        [](void *ctx) {
            QMetaObject::invokeMethod(static_cast<MpvObject *>(ctx), "onMpvEvents",
                                      Qt::QueuedConnection);
        },
        this);

    connect(this, &MpvObject::onUpdate, this, &MpvObject::doUpdate, Qt::QueuedConnection);
}

MpvObject::~MpvObject() {
    if (mpv) mpv_terminate_destroy(mpv);
}

QQuickFramebufferObject::Renderer *MpvObject::createRenderer() const {
    window()->setPersistentGraphics(true);
    window()->setPersistentSceneGraph(true);
    return new MpvRenderer(const_cast<MpvObject *>(this));
}

void MpvObject::doUpdate() { update(); }

void MpvObject::onRenderReady() {
    m_renderReady = true;
    if (!m_pendingFile.isEmpty()) {
        load(m_pendingFile);
        m_pendingFile.clear();
    }
    emitDesktop(jsonStr({{"type", "ready"}}));
}

// ── helpers ──
void MpvObject::command(const QStringList &args) {
    QVector<QByteArray> bytes;
    QVector<const char *> argv;
    bytes.reserve(args.size());
    for (const QString &s : args) bytes.push_back(s.toUtf8());
    for (const QByteArray &b : bytes) argv.push_back(b.constData());
    argv.push_back(nullptr);
    mpv_command(mpv, argv.data());
}

void MpvObject::setOpt(const char *name, const QString &value) {
    const QByteArray v = value.toUtf8();
    mpv_set_property_string(mpv, name, v.constData());
}

void MpvObject::emitDesktop(const QString &json) { emit desktopEvent(json); }

// ── FliksDesktopApi surface ──
void MpvObject::load(const QString &optsJson) {
    if (!m_renderReady) { m_pendingFile = optsJson; return; }
    const QJsonObject o = QJsonDocument::fromJson(optsJson.toUtf8()).object();
    const QString url = o.value("url").toString();
    if (url.isEmpty()) return;
    m_firstFrameSent = false;
    qWarning("[mpv-load] url=%s start=%s headers=%d subs=%d",
             qPrintable(url),
             qPrintable(o.value("startTime").toVariant().toString()),
             o.value("headers").toObject().size(),
             o.value("subtitles").toArray().size());

    // Auth/other headers → mpv http-header-fields (NODE list of "Key: Value").
    if (o.contains("headers") && o.value("headers").isObject()) {
        const QJsonObject h = o.value("headers").toObject();
        QVector<QByteArray> hdrBytes;
        QVector<mpv_node> nodes;
        for (auto it = h.begin(); it != h.end(); ++it) {
            hdrBytes.push_back(
                (it.key() + ": " + it.value().toString()).toUtf8());
        }
        nodes.resize(hdrBytes.size());
        for (int i = 0; i < hdrBytes.size(); ++i) {
            nodes[i].format = MPV_FORMAT_STRING;
            nodes[i].u.string = const_cast<char *>(hdrBytes[i].constData());
        }
        mpv_node_list list{static_cast<int>(nodes.size()), nodes.data(), nullptr};
        mpv_node arr;
        arr.format = MPV_FORMAT_NODE_ARRAY;
        arr.u.list = &list;
        mpv_set_property(mpv, "http-header-fields", MPV_FORMAT_NODE, &arr);
    }

    QString fileOpts;
    if (o.contains("startTime")) {
        const double t = o.value("startTime").toDouble();
        if (t > 0) fileOpts = QStringLiteral("start=%1").arg(t, 0, 'f', 3);
    }

    // loadfile via a named-argument MAP node. The positional signature changed
    // (mpv 0.38 inserted an `index` arg before `options`), so passing options
    // positionally is ambiguous across mpv versions; named args are stable.
    QVector<QByteArray> keyBytes{"name", "url", "flags"};
    QVector<QByteArray> valBytes{"loadfile", url.toUtf8(), "replace"};
    if (!fileOpts.isEmpty()) {
        keyBytes.push_back("options");
        valBytes.push_back(fileOpts.toUtf8());
    }
    QVector<mpv_node> values(keyBytes.size());
    QVector<char *> keys(keyBytes.size());
    for (int i = 0; i < keyBytes.size(); ++i) {
        keys[i] = const_cast<char *>(keyBytes[i].constData());
        values[i].format = MPV_FORMAT_STRING;
        values[i].u.string = const_cast<char *>(valBytes[i].constData());
    }
    mpv_node_list map{static_cast<int>(keyBytes.size()), values.data(), keys.data()};
    mpv_node cmd;
    cmd.format = MPV_FORMAT_NODE_MAP;
    cmd.u.list = &map;
    mpv_command_node(mpv, &cmd, nullptr);

    // Sidecar subtitles, if any.
    for (const QJsonValue &sv : o.value("subtitles").toArray()) {
        const QJsonObject s = sv.toObject();
        const QString surl = s.value("url").toString();
        if (!surl.isEmpty())
            command({QStringLiteral("sub-add"), surl, QStringLiteral("auto"),
                     s.value("label").toString(), s.value("language").toString()});
    }
}

void MpvObject::play() { mpv_set_property_string(mpv, "pause", "no"); }
void MpvObject::pause() { mpv_set_property_string(mpv, "pause", "yes"); }
void MpvObject::seekTo(double position) {
    command({QStringLiteral("seek"), QString::number(position), QStringLiteral("absolute")});
}
void MpvObject::stop() { command({QStringLiteral("stop")}); }
void MpvObject::setPlaybackRate(double rate) { setOpt("speed", QString::number(rate)); }
void MpvObject::setVolume(double volume) { setOpt("volume", QString::number(volume)); }
void MpvObject::setMuted(bool muted) { mpv_set_property_string(mpv, "mute", muted ? "yes" : "no"); }
void MpvObject::setFullscreen(bool enabled) { emit fullscreenRequested(enabled); }

void MpvObject::selectAudioTrack(const QString &id) {
    setOpt("aid", id.isEmpty() ? QStringLiteral("auto") : id);
}
void MpvObject::selectSubtitleTrack(const QString &id) {
    if (id.isEmpty() || id == QLatin1String("null"))
        setOpt("sid", QStringLiteral("no"));
    else
        setOpt("sid", id);
}

void MpvObject::setSubtitleStyle(const QString &styleJson) {
    const QJsonObject s = QJsonDocument::fromJson(styleJson.toUtf8()).object();
    if (s.contains("fontScale"))
        setOpt("sub-scale", QString::number(s.value("fontScale").toDouble()));
    if (s.contains("foregroundColor"))
        setOpt("sub-color", mpvColor(s.value("foregroundColor").toString()));
    if (s.contains("backgroundColor"))
        setOpt("sub-back-color", mpvColor(s.value("backgroundColor").toString()));
    if (s.contains("bottomMarginPercent"))
        setOpt("sub-pos", QString::number(100.0 - s.value("bottomMarginPercent").toDouble()));
}

void MpvObject::destroyPlayer() { command({QStringLiteral("stop")}); }

QString MpvObject::getPosition() {
    double pos = 0, dur = 0, cache = 0;
    mpv_get_property(mpv, "time-pos", MPV_FORMAT_DOUBLE, &pos);
    mpv_get_property(mpv, "duration", MPV_FORMAT_DOUBLE, &dur);
    mpv_get_property(mpv, "demuxer-cache-time", MPV_FORMAT_DOUBLE, &cache);
    return jsonStr({{"position", pos}, {"duration", dur}, {"buffered", cache}});
}

QString MpvObject::getAudioTracks() { return trackListJson(false); }
QString MpvObject::getSubtitleTracks() { return trackListJson(true); }

QString MpvObject::trackListJson(bool subtitles) {
    const char *want = subtitles ? "sub" : "audio";
    QJsonArray out;
    mpv_node node;
    if (mpv_get_property(mpv, "track-list", MPV_FORMAT_NODE, &node) >= 0) {
        if (node.format == MPV_FORMAT_NODE_ARRAY) {
            for (int i = 0; i < node.u.list->num; ++i) {
                const mpv_node &t = node.u.list->values[i];
                if (t.format != MPV_FORMAT_NODE_MAP) continue;
                QString type, id, lang, title;
                bool selected = false;
                for (int j = 0; j < t.u.list->num; ++j) {
                    const QString key = QString::fromUtf8(t.u.list->keys[j]);
                    const mpv_node &v = t.u.list->values[j];
                    if (key == "type" && v.format == MPV_FORMAT_STRING) type = v.u.string;
                    else if (key == "id" && v.format == MPV_FORMAT_INT64) id = QString::number(v.u.int64);
                    else if (key == "lang" && v.format == MPV_FORMAT_STRING) lang = v.u.string;
                    else if (key == "title" && v.format == MPV_FORMAT_STRING) title = v.u.string;
                    else if (key == "selected" && v.format == MPV_FORMAT_FLAG) selected = v.u.flag;
                }
                if (type != QLatin1String(want)) continue;
                QJsonObject e{{"id", id},
                              {"language", lang},
                              {"label", title.isEmpty() ? lang : title},
                              {"selected", selected}};
                if (subtitles) e.insert("forced", false);
                out.append(e);
            }
        }
        mpv_free_node_contents(&node);
    }
    return QString::fromUtf8(QJsonDocument(out).toJson(QJsonDocument::Compact));
}

// ── mpv event loop ──
void MpvObject::onMpvEvents() {
    while (mpv) {
        mpv_event *ev = mpv_wait_event(mpv, 0);
        if (ev->event_id == MPV_EVENT_NONE) break;
        handleMpvEvent(ev);
    }
}

void MpvObject::handleMpvEvent(mpv_event *ev) {
    switch (ev->event_id) {
    case MPV_EVENT_PROPERTY_CHANGE: {
        auto *prop = static_cast<mpv_event_property *>(ev->data);
        const QString name = QString::fromUtf8(prop->name);
        if (name == "time-pos") {
            double pos = (prop->format == MPV_FORMAT_DOUBLE) ? *static_cast<double *>(prop->data) : 0;
            double cache = 0;
            mpv_get_property(mpv, "demuxer-cache-time", MPV_FORMAT_DOUBLE, &cache);
            emitDesktop(jsonStr({{"type", "timeUpdate"},
                                 {"payload", QJsonObject{{"position", pos},
                                                         {"duration", m_duration},
                                                         {"buffered", cache}}}}));
            if (!m_firstFrameSent && pos >= 0) {
                m_firstFrameSent = true;
                emitDesktop(jsonStr({{"type", "firstFrame"}}));
            }
        } else if (name == "duration") {
            if (prop->format == MPV_FORMAT_DOUBLE) m_duration = *static_cast<double *>(prop->data);
        } else if (name == "pause" || name == "core-idle") {
            int paused = 0, idle = 0;
            mpv_get_property(mpv, "pause", MPV_FORMAT_FLAG, &paused);
            mpv_get_property(mpv, "core-idle", MPV_FORMAT_FLAG, &idle);
            const char *state = paused ? "paused" : (idle ? "buffering" : "playing");
            emitDesktop(jsonStr({{"type", "stateChanged"},
                                 {"payload", QJsonObject{{"state", state}}}}));
        } else if (name == "track-list") {
            QJsonObject payload{
                {"audioTracks", QJsonDocument::fromJson(getAudioTracks().toUtf8()).array()},
                {"subtitleTracks", QJsonDocument::fromJson(getSubtitleTracks().toUtf8()).array()}};
            emitDesktop(jsonStr({{"type", "tracksChanged"}, {"payload", payload}}));
        }
        break;
    }
    case MPV_EVENT_END_FILE: {
        auto *ef = static_cast<mpv_event_end_file *>(ev->data);
        if (ef->reason == MPV_END_FILE_REASON_ERROR) {
            emitDesktop(jsonStr({{"type", "error"},
                                 {"payload", QJsonObject{{"code", ef->error},
                                                         {"message", mpv_error_string(ef->error)}}}}));
        } else if (ef->reason == MPV_END_FILE_REASON_EOF) {
            emitDesktop(jsonStr({{"type", "stateChanged"},
                                 {"payload", QJsonObject{{"state", "ended"}}}}));
        }
        break;
    }
    default:
        break;
    }
}
