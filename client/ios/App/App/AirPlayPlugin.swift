import AVFoundation
import AVKit
import Capacitor
import UIKit

/// AirPlay entry of the "play on another device" list. AVPlayer carries the
/// video to the receiver on its own (`allowsExternalPlayback`); this plugin
/// only opens the system route picker and reports the current route.
@objc(AirPlayPlugin)
public class AirPlayPlugin: CAPPlugin, CAPBridgedPlugin, AVRoutePickerViewDelegate {
    public let identifier = "AirPlayPlugin"
    public let jsName = "AirPlay"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showPicker", returnType: CAPPluginReturnPromise),
    ]

    /// Placeholders the route reports while a session is set up or handed off.
    private static let genericRouteNames: Set<String> = ["AirPlay", "AirPlayHandoffDevice"]

    private let detector = AVRouteDetector()
    private var pickerView: AVRoutePickerView?

    override public func load() {
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(routesChanged),
                           name: .AVRouteDetectorMultipleRoutesDetectedDidChange, object: detector)
        center.addObserver(self, selector: #selector(routesChanged),
                           name: AVAudioSession.routeChangeNotification, object: nil)
        // Route discovery costs power: run it only while the app is on screen.
        center.addObserver(self, selector: #selector(startDetection),
                           name: UIApplication.didBecomeActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(stopDetection),
                           name: UIApplication.didEnterBackgroundNotification, object: nil)
        DispatchQueue.main.async { [weak self] in self?.startDetection() }
    }

    @objc private func startDetection() {
        detector.isRouteDetectionEnabled = true
    }

    @objc private func stopDetection() {
        detector.isRouteDetectionEnabled = false
    }

    @objc private func routesChanged() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.notifyListeners("stateChanged", data: self.state())
        }
    }

    /// `deviceName` is set whenever audio goes to an AirPlay receiver, video or
    /// not: the player reads `nativePlayerExternalPlaybackChanged` for video.
    private func state() -> [String: Any] {
        let output = AVAudioSession.sharedInstance().currentRoute.outputs
            .first { $0.portType == .airPlay }
        var state: [String: Any] = [
            "available": detector.multipleRoutesDetected || output != nil,
            "active": output != nil,
        ]
        if let name = output?.portName, !Self.genericRouteNames.contains(name) {
            state["deviceName"] = name
        }
        return state
    }

    @objc func getState(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            call.resolve(self.state())
        }
    }

    /// There is no API to open the picker directly, so an invisible
    /// AVRoutePickerView is laid over the web view and its button pressed.
    @objc func showPicker(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let webView = self.bridge?.webView else {
                call.reject("Bridge not available")
                return
            }
            let picker = self.pickerView ?? AVRoutePickerView()
            picker.delegate = self
            picker.prioritizesVideoDevices = true
            picker.alpha = 0.01
            picker.isUserInteractionEnabled = false
            // Anchors the iPad popover top-right, where every picker trigger sits.
            let insets = webView.safeAreaInsets
            picker.frame = CGRect(
                x: webView.bounds.width - insets.right - 56,
                y: insets.top + 8,
                width: 44,
                height: 44
            )
            if picker.superview !== webView { webView.addSubview(picker) }
            self.pickerView = picker

            guard let button = Self.findButton(in: picker) else {
                picker.removeFromSuperview()
                call.reject("Route picker unavailable")
                return
            }
            button.sendActions(for: .touchUpInside)
            call.resolve()
        }
    }

    public func routePickerViewDidEndPresentingRoutes(_ routePickerView: AVRoutePickerView) {
        routePickerView.removeFromSuperview()
    }

    private static func findButton(in view: UIView) -> UIButton? {
        for sub in view.subviews {
            if let button = sub as? UIButton { return button }
            if let button = findButton(in: sub) { return button }
        }
        return nil
    }
}
