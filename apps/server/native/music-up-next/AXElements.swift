import ApplicationServices

/// The AXUIElements in a CFArray attribute value; nil when it is not one. Bridging the array keeps
/// each element retained after the attribute value itself is released.
func elements(_ value: CFTypeRef?) -> [AXUIElement]? {
  guard let value, CFGetTypeID(value) == CFArrayGetTypeID(), let items = value as? [AnyObject] else {
    return nil
  }
  var result: [AXUIElement] = []
  for item in items {
    guard CFGetTypeID(item) == AXUIElementGetTypeID() else { return nil }
    result.append(item as! AXUIElement)
  }
  return result
}
