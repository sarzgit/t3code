import AppKit
import ApplicationServices
import Security

// T3 Music Up Next: reads, never changes, the rows Music's Up Next panel shows, and writes them
// as JSON to the file T3 names. T3 launches it through LaunchServices so macOS holds this app,
// not T3 Code, responsible for Accessibility. Accessibility lets it read any app's UI; this code
// only ever reads Music's play-queue panel.

struct AXNode: Node {
  let element: AXUIElement
  private func attribute(_ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
  }
  var role: String? { attribute(kAXRoleAttribute) as? String }
  var identifier: String? { attribute(kAXIdentifierAttribute) as? String }
  var title: String? { attribute(kAXTitleAttribute) as? String }
  var descriptionText: String? { attribute(kAXDescriptionAttribute) as? String }
  var value: String? { attribute(kAXValueAttribute) as? String }
  var children: [AXNode] { (attribute(kAXChildrenAttribute) as? [AXUIElement] ?? []).map(AXNode.init) }
  var visibleRows: [AXNode]? { (attribute(kAXVisibleRowsAttribute) as? [AXUIElement])?.map(AXNode.init) }
  var rowCount: Int? {
    var count: CFIndex = 0
    return AXUIElementGetAttributeValueCount(element, kAXRowsAttribute as CFString, &count) == .success ? count : nil
  }
  var index: Int? { attribute(kAXIndexAttribute) as? Int }
}

struct Response: Encodable {
  let request: String
  let read: QueueRead
}

/// This build's code directory hash, so a rebuilt helper (which needs a new grant) may ask again.
func ownCodeHash() -> String {
  var code: SecCode?
  var staticCode: SecStaticCode?
  var info: CFDictionary?
  guard SecCodeCopySelf([], &code) == errSecSuccess, let code,
        SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
        SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
        let unique = (info as? [String: Any])?[kSecCodeInfoUnique as String] as? Data
  else { return "unsigned" }
  return unique.map { String(format: "%02x", $0) }.joined()
}

let environment = ProcessInfo.processInfo.environment
guard let output = environment["T3_MUSIC_UP_NEXT_OUT"], let request = environment["T3_MUSIC_UP_NEXT_REQUEST"] else {
  exit(64)
}
// On its own queue, so it fires even while the main thread waits on Accessibility.
DispatchQueue.global().asyncAfter(deadline: .now() + 10) { exit(75) }
#if STALL_TEST
Thread.sleep(forTimeInterval: 30)
#endif

func respond(_ read: QueueRead) -> Never {
  let data = (try? JSONEncoder().encode(Response(request: request, read: read))) ?? Data()
  try? data.write(to: URL(fileURLWithPath: output), options: .atomic)
  exit(0)
}

if !AXIsProcessTrusted() {
  // Ask macOS once per build, only when T3 asks for it, so polling never repeats the dialog.
  let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("codes.t3.music-up-next", isDirectory: true)
  let marker = support.appendingPathComponent("asked-\(ownCodeHash())")
  if environment["T3_MUSIC_UP_NEXT_PROMPT"] == "1", !FileManager.default.fileExists(atPath: marker.path) {
    try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: marker.path, contents: nil)
    _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary)
  }
  respond(QueueRead(kind: "permission-needed"))
}

guard let music = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Music").first else {
  respond(QueueRead(kind: "not-running"))
}
let app = AXUIElementCreateApplication(music.processIdentifier)
AXUIElementSetMessagingTimeout(app, 3)
var windowsValue: CFTypeRef?
let windows = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsValue) == .success
  ? (windowsValue as? [AXUIElement] ?? []).map(AXNode.init)
  : []
respond(readQueue(windows: windows))
