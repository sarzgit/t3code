import ApplicationServices

/// The elements returned must hold their own retain, or they die with the attribute's array.
/// The array is built by Core Foundation, as Accessibility returns it; creating an element
/// reads nothing, so no Accessibility is needed.
func checkElementsAreRetained() {
  let element = AXUIElementCreateApplication(getpid())
  var values: [UnsafeRawPointer?] = [UnsafeRawPointer(Unmanaged.passUnretained(element).toOpaque())]
  let array = withUnsafePointer(to: kCFTypeArrayCallBacks) { callbacks in
    CFArrayCreate(nil, &values, 1, callbacks)!
  }
  let before = CFGetRetainCount(element)
  let read = elements(array)
  check("elements retained", CFGetRetainCount(element), before + 1)
  check("elements read", read.map { $0.map { CFEqual($0, element) } }, [true])
  check("not an array", elements("text" as CFString) == nil, true)
}
