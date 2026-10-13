import Foundation
import Capacitor
import UIKit

/// Saves a file through the Files "export" picker; WKWebView ignores anchor downloads of blobs.
@objc(SaveFilePlugin)
public class SaveFilePlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "SaveFilePlugin"
    public let jsName = "SaveFile"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise),
    ]

    private var pending: (call: CAPPluginCall, url: URL)?

    @objc func save(_ call: CAPPluginCall) {
        guard let data = Data(base64Encoded: call.getString("data") ?? "") else {
            return call.reject("Invalid data")
        }
        let name = (call.getString("name") ?? "file").replacingOccurrences(of: "/", with: "_")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            return call.reject("Could not write the file", nil, error)
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let vc = self.bridge?.viewController else { return call.reject("No view") }
            self.pending = (call, url)
            let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
            picker.delegate = self
            vc.present(picker, animated: true)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        finish(saved: true)
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finish(saved: false)
    }

    private func finish(saved: Bool) {
        guard let p = pending else { return }
        pending = nil
        try? FileManager.default.removeItem(at: p.url)
        p.call.resolve(["saved": saved])
    }
}
