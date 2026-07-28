import UIKit
import Capacitor

class FlksViewController: CAPBridgeViewController {

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
        bridge?.registerPluginInstance(ImmersivePlugin())
        bridge?.registerPluginInstance(OrientationPlugin())
        bridge?.registerPluginInstance(PipPlugin())
        bridge?.registerPluginInstance(CastPlugin())
        bridge?.registerPluginInstance(DownloadPlugin())
    }

    func updateStatusBar(hidden: Bool) {
        setStatusBarVisible(!hidden)
        // Toggle home indicator via JS bridge call to SystemBars plugin
        let method = hidden ? "hide" : "show"
        let js = "window.Capacitor?.Plugins?.SystemBars?.\(method)({ bar: 'NavigationBar' })"
        webView?.evaluateJavaScript(js)
    }

    func updateStatusBarStyle(light: Bool) {
        setStatusBarStyle(light ? .darkContent : .lightContent)
    }
}
