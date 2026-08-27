import UIKit
import Capacitor
import AVFoundation
import GoogleCast
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    var window: UIWindow?

    // Supported interface orientations for the whole window. Defaults to free
    // rotation; OrientationPlugin narrows it to landscape while the video player
    // is open (see OrientationPlugin.swift) and widens it back on exit.
    var orientationLock: UIInterfaceOrientationMask = .allButUpsideDown

    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        return orientationLock
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Configure audio session for background playback and PiP
        do {
            try AVAudioSession.sharedInstance().setCategory(
                .playback,
                mode: .moviePlayback,
                options: []
            )
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            print("Audio session configuration failed: \(error)")
        }

        // Present download completion banners even while the app is foregrounded
        // (default iOS behaviour suppresses them when the app is active).
        UNUserNotificationCenter.current().delegate = self

        // Initialize Google Cast SDK early (required for device discovery)
        let castOptions = GCKCastOptions(discoveryCriteria:
            GCKDiscoveryCriteria(applicationID: "66BF4DAE"))
        castOptions.disableDiscoveryAutostart = false
        GCKCastContext.setSharedInstanceWith(castOptions)

        // Enable Cast SDK logging for debug
        #if DEBUG
        let logFilter = GCKLoggerFilter()
        logFilter.minimumLevel = .verbose
        GCKLogger.sharedInstance().filter = logFilter
        GCKLogger.sharedInstance().loggingEnabled = true
        #endif

        GCKCastContext.sharedInstance().discoveryManager.startDiscovery()
        print("[Cast] Discovery started, state=\(GCKCastContext.sharedInstance().discoveryManager.discoveryState.rawValue)")

        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    // iOS relaunches the app in the background when our background download
    // session has events to deliver. Stash the completion handler so the
    // DownloadPlugin's session delegate can call it once all events are flushed
    // (urlSessionDidFinishEvents). Not calling it makes the OS throttle us.
    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        guard identifier == BackgroundDownloadCompletion.sessionIdentifier else {
            completionHandler()
            return
        }
        BackgroundDownloadCompletion.handler = completionHandler
        // Only DownloadPlugin.load() recreates the session, and that waits on the
        // Capacitor bridge coming up. If the bridge never gets there the handler
        // stays unanswered and the OS throttles every later transfer, so answer
        // it ourselves once the launch window has had its chance.
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
            BackgroundDownloadCompletion.handler?()
            BackgroundDownloadCompletion.handler = nil
        }
    }

    // Show download banners as alerts while the app is in the foreground.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
