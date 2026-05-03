# iOS Native Player Plugin

## Setup

1. Create the iOS project:
   ```bash
   cd frontend
   npx cap add ios
   ```

2. Copy the plugin file:
   ```bash
   cp ios-plugin-ready/NativePlayerPlugin.swift ios/App/App/
   ```

3. Register the plugin in `ios/App/App/AppDelegate.swift`:
   ```swift
   // In application(_:didFinishLaunchingWithOptions:) or via Capacitor's plugin loader:
   // The plugin auto-registers via CAPBridgedPlugin protocol.
   ```

4. Open in Xcode:
   ```bash
   npx cap open ios
   ```

5. Build and run.
