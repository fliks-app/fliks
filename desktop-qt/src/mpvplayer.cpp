#include "mpvplayer.h"

#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QMetaObject>
#include <clocale>
#include <stdexcept>
#include <chrono>

#include <wayland-client.h>
#include <wayland-egl.h>
#include <EGL/egl.h>

namespace {
QString jsonStr(const QJsonObject &o) {
    return QString::fromUtf8(QJsonDocument(o).toJson(QJsonDocument::Compact));
}

// CSS color → mpv color (#AARRGGBB). mpv rejects "transparent"/"rgba(...)".
QString mpvColor(const QString &css) {
    const QString c = css.trimmed().toLower();
    if (c.isEmpty() || c == QLatin1String("transparent"))
        return QStringLiteral("#00000000");
    if (c.startsWith(QLatin1String("rgba(")) || c.startsWith(QLatin1String("rgb("))) {
        const int lp = c.indexOf('('), rp = c.indexOf(')');
        const QStringList p = c.mid(lp + 1, rp - lp - 1).split(',', Qt::SkipEmptyParts);
        if (p.size() >= 3) {
            const int r = p[0].trimmed().toInt(), g = p[1].trimmed().toInt(), b = p[2].trimmed().toInt();
            const int a = p.size() >= 4 ? qBound(0, qRound(p[3].trimmed().toDouble() * 255.0), 255) : 255;
            return QStringLiteral("#%1%2%3%4")
                .arg(a, 2, 16, QLatin1Char('0')).arg(r, 2, 16, QLatin1Char('0'))
                .arg(g, 2, 16, QLatin1Char('0')).arg(b, 2, 16, QLatin1Char('0'));
        }
    }
    return css;
}

void *egl_get_proc(void *, const char *name) {
    return reinterpret_cast<void *>(eglGetProcAddress(name));
}
} // namespace

MpvPlayer::MpvPlayer(QObject *parent) : QObject(parent) {
    mpv = mpv_create();
    if (!mpv) throw std::runtime_error("mpv_create failed");
    mpv_set_option_string(mpv, "terminal", "yes");
    mpv_set_option_string(mpv, "msg-level", "all=v");
    mpv_set_option_string(mpv, "vo", "libmpv");
    mpv_set_option_string(mpv, "hwdec", "auto-copy");
    mpv_set_option_string(mpv, "keep-open", "yes");
    mpv_set_option_string(mpv, "force-seekable", "yes");
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
            QMetaObject::invokeMethod(static_cast<MpvPlayer *>(ctx), "onMpvEvents",
                                      Qt::QueuedConnection);
        },
        this);
}

MpvPlayer::~MpvPlayer() {
    m_running = false;
    m_cv.notify_all();
    if (m_renderThread.joinable()) m_renderThread.join();
    if (mpv) mpv_terminate_destroy(mpv);
}

// ── Wayland subsurface render wiring ──
void MpvPlayer::initRender(wl_display *display, wl_surface *surface, int w, int h) {
    m_wlDisplay = display;
    m_wlSurface = surface;
    m_w = w;
    m_h = h;
    m_running = true;
    m_renderThread = std::thread(&MpvPlayer::renderThreadFunc, this);
}

void MpvPlayer::resizeSurface(int w, int h) {
    m_w = w;
    m_h = h;
    m_wantResize = true;
    m_cv.notify_one();
}

void MpvPlayer::renderThreadFunc() {
    EGLDisplay dpy = eglGetDisplay(reinterpret_cast<EGLNativeDisplayType>(m_wlDisplay));
    if (dpy == EGL_NO_DISPLAY || !eglInitialize(dpy, nullptr, nullptr)) {
        qWarning("[mpv-egl] eglInitialize failed"); return;
    }
    eglBindAPI(EGL_OPENGL_API);
    const EGLint cfgAttr[] = {
        EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
        EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
        EGL_NONE};
    EGLConfig cfg; EGLint nCfg = 0;
    if (!eglChooseConfig(dpy, cfgAttr, &cfg, 1, &nCfg) || nCfg < 1) {
        qWarning("[mpv-egl] eglChooseConfig failed"); return;
    }
    m_eglWindow = wl_egl_window_create(m_wlSurface, m_w, m_h);
    EGLSurface surf = eglCreateWindowSurface(
        dpy, cfg, reinterpret_cast<EGLNativeWindowType>(m_eglWindow), nullptr);
    EGLContext ctx = eglCreateContext(dpy, cfg, EGL_NO_CONTEXT, nullptr);
    if (surf == EGL_NO_SURFACE || ctx == EGL_NO_CONTEXT) {
        qWarning("[mpv-egl] surface/context create failed"); return;
    }
    eglMakeCurrent(dpy, surf, surf, ctx);
    eglSwapInterval(dpy, 1);
    m_eglDisplay = dpy; m_eglSurface = surf; m_eglContext = ctx;

    mpv_opengl_init_params gl{};
    gl.get_proc_address = egl_get_proc;
    mpv_render_param params[]{
        {MPV_RENDER_PARAM_API_TYPE, const_cast<char *>(MPV_RENDER_API_TYPE_OPENGL)},
        {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl},
        {MPV_RENDER_PARAM_INVALID, nullptr}};
    if (mpv_render_context_create(&m_render, mpv, params) < 0) {
        qWarning("[mpv-egl] mpv_render_context_create failed"); return;
    }
    mpv_render_context_set_update_callback(
        m_render,
        [](void *ctx) {
            auto *self = static_cast<MpvPlayer *>(ctx);
            self->m_wantRedraw = true;
            self->m_cv.notify_one();
        },
        this);

    while (m_running) {
        {
            std::unique_lock<std::mutex> lk(m_mtx);
            m_cv.wait_for(lk, std::chrono::milliseconds(100), [&] {
                return m_wantRedraw.load() || m_wantResize.load() || !m_running.load();
            });
        }
        if (!m_running) break;
        if (m_wantResize.exchange(false))
            wl_egl_window_resize(m_eglWindow, m_w, m_h, 0, 0);
        if (!(mpv_render_context_update(m_render) & MPV_RENDER_UPDATE_FRAME)) continue;
        m_wantRedraw = false;
        // Render at the ACTUAL back-buffer size, not the requested one — after a
        // resize the buffer lags a frame; a mismatch yields stride-garbage.
        EGLint bw = m_w.load(), bh = m_h.load();
        eglQuerySurface(dpy, surf, EGL_WIDTH, &bw);
        eglQuerySurface(dpy, surf, EGL_HEIGHT, &bh);
        mpv_opengl_fbo fbo{0, static_cast<int>(bw), static_cast<int>(bh), 0}; // fbo 0 = EGL window
        int flip_y = 1;                                    // GL window is bottom-up
        mpv_render_param rp[]{
            {MPV_RENDER_PARAM_OPENGL_FBO, &fbo},
            {MPV_RENDER_PARAM_FLIP_Y, &flip_y},
            {MPV_RENDER_PARAM_INVALID, nullptr}};
        mpv_render_context_render(m_render, rp);
        eglSwapBuffers(dpy, surf);
    }

    if (m_render) { mpv_render_context_free(m_render); m_render = nullptr; }
    eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    if (surf != EGL_NO_SURFACE) eglDestroySurface(dpy, surf);
    if (ctx != EGL_NO_CONTEXT) eglDestroyContext(dpy, ctx);
    if (m_eglWindow) wl_egl_window_destroy(m_eglWindow);
}

// ── helpers ──
void MpvPlayer::command(const QStringList &args) {
    QVector<QByteArray> bytes;
    QVector<const char *> argv;
    for (const QString &s : args) bytes.push_back(s.toUtf8());
    for (const QByteArray &b : bytes) argv.push_back(b.constData());
    argv.push_back(nullptr);
    mpv_command(mpv, argv.data());
}

void MpvPlayer::setOpt(const char *name, const QString &value) {
    const QByteArray v = value.toUtf8();
    mpv_set_property_string(mpv, name, v.constData());
}

void MpvPlayer::emitDesktop(const QString &json) { emit desktopEvent(json); }

// ── FliksDesktopApi surface ──
void MpvPlayer::load(const QString &optsJson) {
    const QJsonObject o = QJsonDocument::fromJson(optsJson.toUtf8()).object();
    const QString url = o.value("url").toString();
    if (url.isEmpty()) return;
    m_firstFrameSent = false;

    if (o.value("headers").isObject()) {
        const QJsonObject h = o.value("headers").toObject();
        QVector<QByteArray> hdrBytes;
        for (auto it = h.begin(); it != h.end(); ++it)
            hdrBytes.push_back((it.key() + ": " + it.value().toString()).toUtf8());
        QVector<mpv_node> nodes(hdrBytes.size());
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
    // loadfile via a named-argument MAP node — version-agnostic across mpv's
    // loadfile signature change (0.38 inserted an `index` arg before options).
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

    for (const QJsonValue &sv : o.value("subtitles").toArray()) {
        const QJsonObject s = sv.toObject();
        const QString surl = s.value("url").toString();
        if (!surl.isEmpty())
            command({QStringLiteral("sub-add"), surl, QStringLiteral("auto"),
                     s.value("label").toString(), s.value("language").toString()});
    }
}

void MpvPlayer::play() { mpv_set_property_string(mpv, "pause", "no"); }
void MpvPlayer::pause() { mpv_set_property_string(mpv, "pause", "yes"); }
void MpvPlayer::seekTo(double position) {
    command({QStringLiteral("seek"), QString::number(position), QStringLiteral("absolute")});
}
void MpvPlayer::stop() { command({QStringLiteral("stop")}); }
void MpvPlayer::setPlaybackRate(double rate) { setOpt("speed", QString::number(rate)); }
void MpvPlayer::setVolume(double volume) { setOpt("volume", QString::number(volume)); }
void MpvPlayer::setMuted(bool muted) { mpv_set_property_string(mpv, "mute", muted ? "yes" : "no"); }
void MpvPlayer::setFullscreen(bool enabled) { emit fullscreenRequested(enabled); }

void MpvPlayer::selectAudioTrack(const QString &id) {
    setOpt("aid", id.isEmpty() ? QStringLiteral("auto") : id);
}
void MpvPlayer::selectSubtitleTrack(const QString &id) {
    setOpt("sid", (id.isEmpty() || id == QLatin1String("null")) ? QStringLiteral("no") : id);
}

void MpvPlayer::setSubtitleStyle(const QString &styleJson) {
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

void MpvPlayer::destroyPlayer() { command({QStringLiteral("stop")}); }

QString MpvPlayer::getPosition() {
    double pos = 0, dur = 0, cache = 0;
    mpv_get_property(mpv, "time-pos", MPV_FORMAT_DOUBLE, &pos);
    mpv_get_property(mpv, "duration", MPV_FORMAT_DOUBLE, &dur);
    mpv_get_property(mpv, "demuxer-cache-time", MPV_FORMAT_DOUBLE, &cache);
    return jsonStr({{"position", pos}, {"duration", dur}, {"buffered", cache}});
}

QString MpvPlayer::getAudioTracks() { return trackListJson(false); }
QString MpvPlayer::getSubtitleTracks() { return trackListJson(true); }

QString MpvPlayer::trackListJson(bool subtitles) {
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
                QJsonObject e{{"id", id}, {"language", lang},
                              {"label", title.isEmpty() ? lang : title}, {"selected", selected}};
                if (subtitles) e.insert("forced", false);
                out.append(e);
            }
        }
        mpv_free_node_contents(&node);
    }
    return QString::fromUtf8(QJsonDocument(out).toJson(QJsonDocument::Compact));
}

// ── mpv event loop (GUI thread) ──
void MpvPlayer::onMpvEvents() {
    while (mpv) {
        mpv_event *ev = mpv_wait_event(mpv, 0);
        if (ev->event_id == MPV_EVENT_NONE) break;
        handleMpvEvent(ev);
    }
}

void MpvPlayer::handleMpvEvent(mpv_event *ev) {
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
        if (ef->reason == MPV_END_FILE_REASON_ERROR)
            emitDesktop(jsonStr({{"type", "error"},
                                 {"payload", QJsonObject{{"code", ef->error},
                                                         {"message", mpv_error_string(ef->error)}}}}));
        else if (ef->reason == MPV_END_FILE_REASON_EOF)
            emitDesktop(jsonStr({{"type", "stateChanged"},
                                 {"payload", QJsonObject{{"state", "ended"}}}}));
        break;
    }
    default:
        break;
    }
}
