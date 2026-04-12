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

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativePlayerPlugin())
        bridge?.registerPluginInstance(HdrPlugin())
        bridge?.registerPluginInstance(ImmersivePlugin())
        bridge?.registerPluginInstance(PipPlugin())
        bridge?.registerPluginInstance(CastPlugin())
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
