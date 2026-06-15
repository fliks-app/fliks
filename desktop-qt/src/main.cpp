#include <QtGui/QGuiApplication>
#include <QtGui/QVulkanInstance>
#include <QtGui/qguiapplication_platform.h>   // QNativeInterface::QWaylandApplication
#include <QtQml/QQmlApplicationEngine>
#include <QtQml/qqml.h>
#include <QtQuick/QQuickWindow>
#include <QtQuick/QSGRendererInterface>
#include <QtWebEngineQuick/QtWebEngineQuick>
#include <QtWebEngineCore/QWebEngineProfile>
#include <QtWebEngineCore/QWebEngineScript>
#include <QtWebEngineCore/QWebEngineScriptCollection>
#include <QtWebEngineCore/QWebEngineUrlScheme>
#include <QUrl>
#include <QFile>
#include <QByteArray>
#include <QTimer>
#include <clocale>
#include <cstring>

#include <qpa/qplatformnativeinterface.h>
#include <wayland-client.h>

#include "mpvplayer.h"
#include "schemehandler.h"

// wl_subcompositor isn't exposed by QWaylandApplication; bind it off the registry.
static wl_subcompositor *g_subcompositor = nullptr;
static void reg_global(void *, wl_registry *r, uint32_t name, const char *iface, uint32_t) {
    if (std::strcmp(iface, wl_subcompositor_interface.name) == 0)
        g_subcompositor = static_cast<wl_subcompositor *>(
            wl_registry_bind(r, name, &wl_subcompositor_interface, 1));
}
static const wl_registry_listener reg_listener = {reg_global, [](void *, wl_registry *, uint32_t) {}};

// Build the mpv Wayland subsurface BELOW the Qt window and start mpv rendering.
static void setupSubsurface(QQuickWindow *win, MpvPlayer *player) {
    auto *wlApp = qApp->nativeInterface<QNativeInterface::QWaylandApplication>();
    if (!wlApp) { qWarning("[fliks] no Wayland application interface"); return; }
    wl_display *dpy = wlApp->display();
    wl_compositor *comp = wlApp->compositor();

    wl_registry *registry = wl_display_get_registry(dpy);
    wl_registry_add_listener(registry, &reg_listener, nullptr);
    wl_display_roundtrip(dpy);
    if (!comp || !g_subcompositor) { qWarning("[fliks] missing wl_compositor/subcompositor"); return; }

    auto *native = QGuiApplication::platformNativeInterface();
    auto *qtSurface = static_cast<wl_surface *>(
        native->nativeResourceForWindow("surface", win));
    if (!qtSurface) { qWarning("[fliks] no Qt wl_surface yet"); return; }

    wl_surface *mpvSurface = wl_compositor_create_surface(comp);
    wl_subsurface *sub = wl_subcompositor_get_subsurface(g_subcompositor, mpvSurface, qtSurface);
    wl_subsurface_set_position(sub, 0, 0);
    wl_subsurface_place_below(sub, qtSurface);  // video behind, web UI on top
    wl_subsurface_set_desync(sub);              // mpv presents independently
    wl_surface_commit(mpvSurface);
    wl_display_roundtrip(dpy);

    player->initRender(dpy, mpvSurface, win->width(), win->height());
    QObject::connect(win, &QQuickWindow::widthChanged,
                     [win, player](int) { player->resizeSurface(win->width(), win->height()); });
    QObject::connect(win, &QQuickWindow::heightChanged,
                     [win, player](int) { player->resizeSurface(win->width(), win->height()); });
    qWarning("[fliks] mpv subsurface ready (%dx%d)", win->width(), win->height());
}

int main(int argc, char *argv[]) {
    // --disable-web-security: cross-origin calls to the remote Fliks server.
    // --disable-gpu-compositing: software page compositing redraws the full
    //   surface each frame, so the page's transparent regions stay transparent
    //   in the window surface (the GPU delegated compositor otherwise repeats the
    //   prior opaque frame, hiding the mpv subsurface until a resize).
    qputenv("QTWEBENGINE_CHROMIUM_FLAGS",
            "--disable-web-security --disable-gpu-compositing");

    {
        // STANDARD (host-based), secure, CORS-capable scheme. Host syntax →
        // fliks://app/ gives host "app", path "/".
        QWebEngineUrlScheme scheme("fliks");
        scheme.setSyntax(QWebEngineUrlScheme::Syntax::Host);
        scheme.setDefaultPort(QWebEngineUrlScheme::PortUnspecified);
        scheme.setFlags(QWebEngineUrlScheme::SecureScheme |
                        QWebEngineUrlScheme::CorsEnabled |
                        QWebEngineUrlScheme::ServiceWorkersAllowed);
        QWebEngineUrlScheme::registerScheme(scheme);
    }

    // Qt composites the web UI on the VULKAN RHI backend. QtWebEngine's
    // transparent compositing ghosts on the OpenGL RHI (QTBUG-111739) — the
    // transparent page repeats the previous frame instead of going transparent,
    // hiding the mpv subsurface below. The Vulkan path composites transparency
    // correctly (the Plex/JMP subsurface model). mpv keeps its own GL/EGL on the
    // subsurface, independent of Qt's Vulkan rendering.
    QQuickWindow::setGraphicsApi(QSGRendererInterface::Vulkan);

    QtWebEngineQuick::initialize();
    QGuiApplication app(argc, argv);
    std::setlocale(LC_NUMERIC, "C"); // libmpv requires the C numeric locale

    const QString webDir = qEnvironmentVariable(
        "FLIKS_WEB_DIR", QStringLiteral("/tmp/fliks-verify/browser"));

    auto *profile = QWebEngineProfile::defaultProfile();
    // The client keys isNative on an `Electron/` UA token → server-setup +
    // absolute API URLs, same as the Electron shell.
    profile->setHttpUserAgent(profile->httpUserAgent() + QStringLiteral(" Electron/42.0.0"));
    profile->installUrlSchemeHandler("fliks", new FliksSchemeHandler(webDir, &app));

    QByteArray js;
    {
        QFile f(QStringLiteral(":/qtwebchannel/qwebchannel.js"));
        if (f.open(QIODevice::ReadOnly)) js = f.readAll();
    }
    {
        QFile f(QStringLiteral(SHIM_JS));
        if (f.open(QIODevice::ReadOnly)) js += "\n" + f.readAll();
    }
    QWebEngineScript script;
    script.setName(QStringLiteral("fliksBridge"));
    script.setInjectionPoint(QWebEngineScript::DocumentCreation);
    script.setWorldId(QWebEngineScript::MainWorld);
    script.setRunsOnSubFrames(false);
    script.setSourceCode(QString::fromUtf8(js));
    profile->scripts()->insert(script);

    // Shared Vulkan instance for the QtQuick/QtWebEngine window rendering.
    QVulkanInstance vulkanInstance;
    vulkanInstance.setApiVersion(QVersionNumber(1, 2));
    if (!vulkanInstance.create()) { qWarning("[fliks] Vulkan instance create failed"); return -1; }

    qmlRegisterType<MpvPlayer>("FliksSpike", 1, 0, "MpvPlayer");

    QQmlApplicationEngine engine;
    engine.load(QUrl::fromLocalFile(QStringLiteral(QML_MAIN)));
    if (engine.rootObjects().isEmpty()) return -1;

    auto *win = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
    auto *player = win ? win->findChild<MpvPlayer *>(QStringLiteral("mpv")) : nullptr;
    if (win) win->setVulkanInstance(&vulkanInstance);
    if (win && player) {
        // Defer until the window is exposed so its wl_surface exists.
        QTimer::singleShot(0, [win, player] { setupSubsurface(win, player); });
    }

    return app.exec();
}
