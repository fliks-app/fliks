import Foundation
import Capacitor
import EventKit
import EventKitUI

/// Adds an event through the system event sheet; iOS 17+ needs no calendar access for it.
@objc(CalendarPlugin)
public class CalendarPlugin: CAPPlugin, CAPBridgedPlugin, EKEventEditViewDelegate {
    public let identifier = "CalendarPlugin"
    public let jsName = "Calendar"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "addEvent", returnType: CAPPluginReturnPromise),
    ]

    private let store = EKEventStore()
    private var pending: CAPPluginCall?

    @objc func addEvent(_ call: CAPPluginCall) {
        guard let title = call.getString("title"),
              let start = call.getDouble("start"),
              let end = call.getDouble("end") else {
            return call.reject("Missing event fields")
        }
        if #available(iOS 17.0, *) {
            DispatchQueue.main.async { self.present(call, title, start, end) }
        } else {
            store.requestAccess(to: .event) { granted, _ in
                DispatchQueue.main.async {
                    if granted { self.present(call, title, start, end) } else { call.reject("Calendar access denied") }
                }
            }
        }
    }

    private func present(_ call: CAPPluginCall, _ title: String, _ start: Double, _ end: Double) {
        guard let vc = bridge?.viewController else { return call.reject("No view") }
        let event = EKEvent(eventStore: store)
        event.title = title
        event.startDate = Date(timeIntervalSince1970: start / 1000)
        event.endDate = Date(timeIntervalSince1970: end / 1000)
        event.notes = call.getString("notes")
        if let url = call.getString("url") { event.url = URL(string: url) }
        event.calendar = store.defaultCalendarForNewEvents
        let sheet = EKEventEditViewController()
        sheet.eventStore = store
        sheet.event = event
        sheet.editViewDelegate = self
        pending = call
        vc.present(sheet, animated: true)
    }

    public func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
        controller.dismiss(animated: true)
        pending?.resolve(["added": action == .saved])
        pending = nil
    }
}
