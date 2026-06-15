import QtQuick
import QtQuick.Window
import QtWebEngine
import QtWebChannel
import FliksSpike

// Transparent window: the only thing in the QtQuick scene is the transparent
// WebEngineView, so it composites over nothing (no in-scene content) — which
// sidesteps QtWebEngine's transparent ghosting (QTBUG-111739). mpv renders the
// video into a Wayland SUBSURFACE placed BELOW this window (set up in main.cpp),
// so it shows through the transparent page. The client drives mpv through
// window.fliksDesktop, backed by the WebChannel-exposed MpvPlayer.
Window {
    id: win
    width: 1280
    height: 800
    visible: true
    color: "transparent"
    title: "Fliks"

    MpvPlayer {
        id: mpv
        objectName: "mpv"
        WebChannel.id: "mpv"
        onFullscreenRequested: (enabled) =>
            win.visibility = enabled ? Window.FullScreen : Window.Windowed
    }

    WebChannel {
        id: chan
        registeredObjects: [mpv]
    }

    WebEngineView {
        id: web
        anchors.fill: parent
        backgroundColor: "transparent"   // mpv subsurface shows through
        webChannel: chan
        url: "fliks://app/"
    }
}
