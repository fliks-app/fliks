import UIKit
import Capacitor

class FlksViewController: CAPBridgeViewController {

    /// While immersive (the player), the first bottom-edge swipe goes to the page (the reaction row), the second to iOS.
    private var deferBottomEdge = false

    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge {
        deferBottomEdge ? .bottom : []
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        #if DEBUG
        if #available(iOS 16.4, *) {
            webView?.isInspectable = true
        }
        #endif
    }

    // CAPBridgeViewController answers this from a static Info.plist list, so the
    // OrientationPlugin's dynamic mask would be ignored. Read the mask here — the
    // view-controller level is the orientation authority iOS re-queries on
    // setNeedsUpdateOfSupportedInterfaceOrientations.
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        return (UIApplication.shared.delegate as? AppDelegate)?.orientationLock ?? .allButUpsideDown
    }

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativePlayerPlugin())
        bridge?.registerPluginInstance(HdrPlugin())
        bridge?.registerPluginInstance(AudioCapabilitiesPlugin())
        bridge?.registerPluginInstance(VideoCapabilitiesPlugin())
        bridge?.registerPluginInstance(ImmersivePlugin())
        bridge?.registerPluginInstance(OrientationPlugin())
        bridge?.registerPluginInstance(PipPlugin())
        bridge?.registerPluginInstance(CastPlugin())
        bridge?.registerPluginInstance(DownloadPlugin())
        bridge?.registerPluginInstance(BackGesturePlugin())
        bridge?.registerPluginInstance(AirPlayPlugin())
        bridge?.registerPluginInstance(SaveFilePlugin())
        bridge?.registerPluginInstance(CalendarPlugin())
    }

    func updateStatusBar(hidden: Bool) {
        setStatusBarVisible(!hidden)
        deferBottomEdge = hidden
        setNeedsUpdateOfScreenEdgesDeferringSystemGestures()
        // Toggle home indicator via JS bridge call to SystemBars plugin
        let method = hidden ? "hide" : "show"
        let js = "window.Capacitor?.Plugins?.SystemBars?.\(method)({ bar: 'NavigationBar' })"
        webView?.evaluateJavaScript(js)
    }

    func updateStatusBarStyle(light: Bool) {
        setStatusBarStyle(light ? .darkContent : .lightContent)
    }
}
