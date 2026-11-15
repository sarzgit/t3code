import Foundation
// Run with ./test.sh: the reader against fixture trees, no Accessibility needed.
struct Fixture: Node {
  var role: String? = nil
  var identifier: String? = nil
  var title: String? = nil
  var descriptionText: String? = nil
  var value: String? = nil
  var children: [Fixture] = []
  var visibleRows: [Fixture]? = nil
  var rowCount: Int? = nil
  var index: Int? = nil
}

var failures = 0
func check<T: Equatable>(_ name: String, _ actual: T, _ expected: T) {
  if actual != expected { failures += 1; print("FAIL \(name):\n  got      \(actual)\n  expected \(expected)") }
}

func text(_ value: String) -> Fixture { Fixture(role: "AXStaticText", value: value) }
func button(_ id: String, _ label: String? = nil) -> Fixture { Fixture(role: "AXButton", identifier: id, title: label) }
func cellRow(_ index: Int, _ cell: [Fixture]) -> Fixture {
  Fixture(role: "AXRow", children: [Fixture(role: "AXCell", children: cell)], index: index)
}
func panel(_ rows: [Fixture], rowCount: Int, visible: Bool = true) -> Fixture {
  let table = Fixture(role: "AXTable", children: rows, visibleRows: visible ? rows : nil, rowCount: rowCount)
  let scroller = Fixture(role: "AXScrollArea", identifier: "scroller", children: [table])
  return Fixture(role: "AXGroup", identifier: "headerContainer", children: [scroller])
}
let queueToggle = button("Music.miniPlayer.queueButton")

// The panel in the Mini Player, with a combined label split across texts, a header, and More buttons.
let rows = [
  cellRow(200, [text("Old song"), button("actionButton", "More")]),
  cellRow(201, [text("Continue Playing"), button("from", "From musics!"), button("action", "Clear")]),
  cellRow(202, [text("Vacile"), text("Yan Block — Vacile - Single"), button("actionButton", "More")]),
  Fixture(role: "AXRow", descriptionText: "Fuma Bad Gyal — Fuma - Single", children: [Fixture(role: "AXCell", children: [button("actionButton")])], index: 203),
]
let mini = Fixture(role: "AXWindow", title: "Mini Player", children: [queueToggle, panel(rows, rowCount: 302)])
let main = Fixture(role: "AXWindow", title: "Music", children: [button("Music.main.queueButton")])
check("reads the panel, Mini Player first", readQueue(windows: [main, mini]), QueueRead(
  kind: "panel",
  rows: [
    QueueRow(texts: ["Old song"], buttons: [QueueButton(id: "actionButton", label: "More")]),
    QueueRow(texts: ["Continue Playing"], buttons: [QueueButton(id: "from", label: "From musics!"), QueueButton(id: "action", label: "Clear")]),
    QueueRow(texts: ["Vacile Yan Block — Vacile - Single"], buttons: [QueueButton(id: "actionButton", label: "More")]),
    QueueRow(texts: ["Fuma Bad Gyal — Fuma - Single"], buttons: [QueueButton(id: "actionButton", label: nil)]),
  ],
  lastVisibleIndex: 203,
  rowCount: 302
))

// Closed: the Mini Player was searched to the end and has its queue button but no panel.
check("closed", readQueue(windows: [Fixture(role: "AXWindow", title: "Mini Player", children: [queueToggle])]), QueueRead(kind: "closed"))

// A queue button seen before the budget ran out is not proof the panel is closed.
let busy = Fixture(role: "AXWindow", title: "Music", children: [queueToggle] + Array(repeating: Fixture(role: "AXGroup"), count: 500))
check("budget exhausted is unrecognised", readQueue(windows: [busy]), QueueRead(kind: "unrecognised"))
check("no button, no panel", readQueue(windows: [Fixture(role: "AXWindow")]), QueueRead(kind: "unrecognised"))

// Found but its visible rows can't be read.
let hidden = Fixture(role: "AXWindow", title: "Mini Player", children: [panel(rows, rowCount: 302, visible: false)])
check("unreadable", readQueue(windows: [hidden]), QueueRead(kind: "unreadable"))

// The row cap applies before the last index is taken.
let many = (0..<100).map { cellRow($0, [text("Song \($0)"), button("actionButton")]) }
let capped = readQueue(windows: [Fixture(role: "AXWindow", title: "Mini Player", children: [panel(many, rowCount: 100)])])
check("cap rows", capped.rows?.count, 80)
check("cap last index", capped.lastVisibleIndex, 79)

if failures == 0 { print("reader tests passed") } else { print("\(failures) failed"); exit(1) }
