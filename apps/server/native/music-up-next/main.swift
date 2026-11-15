import AppKit
import ApplicationServices
import Security

// T3 Music Up Next: reads, never changes, the rows Music's Up Next panel shows, and writes them
// as JSON to the file T3 names. T3 launches it through LaunchServices so macOS holds this app,
// not T3 Code, responsible for Accessibility. Accessibility lets it read and control other apps'
// windows; this code only ever reads Music's play-queue panel.

/// The AXUIElements in a CFArray; nil when the value is not one.
func elements(_ value: CFTypeRef?) -> [AXUIElement]? {
  guard let value, CFGetTypeID(value) == CFArrayGetTypeID() else { return nil }
  let array = value as! CFArray
  var result: [AXUIElement] = []
  for i in 0..<CFArrayGetCount(array) {
    let item = unsafeBitCast(CFArrayGetValueAtIndex(array, i), to: CFTypeRef.self)
    guard CFGetTypeID(item) == AXUIElementGetTypeID() else { return nil }
    result.append(item as! AXUIElement)
  }
  return result
}

struct AXNode: Node {
  let element: AXUIElement
  private func copy(_ name: String) -> (AXError, CFTypeRef?) {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return (error, value)
  }
  private func attribute(_ name: String) -> CFTypeRef? {
    let (error, value) = copy(name)
    return error == .success ? value : nil
  }
  var role: String? { attribute(kAXRoleAttribute) as? String }
  var identifier: String? { attribute(kAXIdentifierAttribute) as? String }
  var title: String? { attribute(kAXTitleAttribute) as? String }
  var descriptionText: String? { attribute(kAXDescriptionAttribute) as? String }
  var value: String? { attribute(kAXValueAttribute) as? String }
  var children: [AXNode]? {
    let (error, value) = copy(kAXChildrenAttribute)
    switch error {
    case .success: return elements(value)?.map(AXNode.init)
    // No children, as opposed to a read that failed.
    case .noValue, .attributeUnsupported: return []
    default: return nil
    }
  }
  var visibleRows: [AXNode]? { elements(attribute(kAXVisibleRowsAttribute))?.map(AXNode.init) }
  var rowCount: Int? {
    var count: CFIndex = 0
    return AXUIElementGetAttributeValueCount(element, kAXRowsAttribute as CFString, &count) == .success ? count : nil
  }
  var index: Int? { (attribute(kAXIndexAttribute) as? NSNumber)?.intValue }
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
// Only a fresh queue.json and a numeric request id: whoever launches it can't aim it elsewhere.
guard let output = environment["T3_MUSIC_UP_NEXT_OUT"], output.hasSuffix("/queue.json"),
      !FileManager.default.fileExists(atPath: output),
      let request = environment["T3_MUSIC_UP_NEXT_REQUEST"], !request.isEmpty, request.count <= 64,
      request.allSatisfy({ $0.isNumber || $0 == "-" })
else {
  exit(64)
}
// On its own queue, so it fires even while the main thread waits on Accessibility.
DispatchQueue.global().asyncAfter(deadline: .now() + 10) { exit(75) }
#if STALL_TEST
Thread.sleep(forTimeInterval: 30)
#endif

func write(_ read: QueueRead) {
  let data = (try? JSONEncoder().encode(Response(request: request, read: read))) ?? Data()
  try? data.write(to: URL(fileURLWithPath: output), options: .atomic)
}

func respond(_ read: QueueRead) -> Never {
  write(read)
  exit(0)
}

// One timeout for every element this process reads, not only the one it is set on.
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 3)

if !AXIsProcessTrusted() {
  // Ask macOS once per build, only when T3 asks for it, so polling never repeats the dialog.
  let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("codes.t3.music-up-next", isDirectory: true)
  let marker = support.appendingPathComponent("asked-\(ownCodeHash())")
  write(QueueRead(kind: "permission-needed"))
  if environment["T3_MUSIC_UP_NEXT_PROMPT"] == "1", !FileManager.default.fileExists(atPath: marker.path) {
    _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary)
    // The dialog is shown asynchronously; staying up lets macOS show it. The watchdog still holds.
    let until = Date().addingTimeInterval(8)
    while Date() < until, !AXIsProcessTrusted() {
      RunLoop.main.run(until: Date().addingTimeInterval(0.5))
    }
    try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: marker.path, contents: nil)
  }
  exit(0)
}

guard let music = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Music").first else {
  respond(QueueRead(kind: "not-running"))
}
let app = AXUIElementCreateApplication(music.processIdentifier)
var windowsValue: CFTypeRef?
guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsValue) == .success,
      let windows = elements(windowsValue)
else {
  respond(QueueRead(kind: "unrecognised"))
}
respond(readQueue(windows: windows.map(AXNode.init)))
