import ApplicationServices

/// The elements returned must hold their own retain, or they die with the attribute's array
/// (no Accessibility needed: creating an element doesn't read anything).
func checkElementsAreRetained() {
  let element = AXUIElementCreateApplication(getpid())
  let array = [element] as CFArray
  let before = CFGetRetainCount(element)
  let read = elements(array)
  check("elements retained", CFGetRetainCount(element), before + 1)
  check("elements read", read?.count, 1)
  check("not an array", elements("text" as CFString) == nil, true)
}
