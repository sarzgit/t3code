import Foundation

// Reads the rows Music's Up Next panel shows. Generic over Node so a fixture tree can test it.

protocol Node {
  var role: String? { get }
  var identifier: String? { get }
  var title: String? { get }
  var descriptionText: String? { get }
  var value: String? { get }
  /** nil when the children could not be read, as opposed to there being none. */
  var children: [Self]? { get }
  /** AXVisibleRows of a table; nil when the attribute can't be read. */
  var visibleRows: [Self]? { get }
  var rowCount: Int? { get }
  var index: Int? { get }
}

struct QueueButton: Encodable, Equatable {
  let id: String?
  let label: String?
}

struct QueueRow: Encodable, Equatable {
  let texts: [String]
  let buttons: [QueueButton]
}

struct QueueRead: Encodable, Equatable {
  let kind: String
  var rows: [QueueRow]? = nil
  var lastVisibleIndex: Int? = nil
  var rowCount: Int? = nil
}

let maxElementsPerWindow = 400
let maxRows = 80
/// Containers whose children are content, not layout; the queue table is never inside them.
let leafRoles: Set<String> = ["AXTable", "AXOutline", "AXList", "AXRow", "AXBrowser", "AXWebArea", "AXMenuBar"]

func nonEmpty(_ value: String?) -> String? {
  guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
  return String(value.prefix(500))
}

/// The queue table inside Music's play-queue container: headerContainer › scroller › table.
func queueTable<N: Node>(in container: N) -> N? {
  for area in container.children ?? [] where area.identifier == "scroller" {
    if let table = area.children?.first(where: { $0.role == "AXTable" }) { return table }
  }
  return nil
}

enum WindowSearch<N: Node> {
  case found(N)
  /** Searched to the end: nothing failed, the budget held, no play-queue container was seen. */
  case searched(sawQueueButton: Bool)
  /** The budget ran out, a read failed, or Music's container no longer holds the table. */
  case inconclusive
}

func searchWindow<N: Node>(_ window: N) -> WindowSearch<N> {
  var pending: [N] = [window]
  var seen = 0
  var sawQueueButton = false
  // A failed read elsewhere doesn't hide the panel; it only stops this window proving it closed.
  var failed = false
  while !pending.isEmpty {
    if seen >= maxElementsPerWindow { return .inconclusive }
    let node = pending.removeFirst()
    seen += 1
    if node.identifier == "headerContainer" {
      guard let table = queueTable(in: node) else { return .inconclusive }
      return .found(table)
    }
    if let id = node.identifier, id.hasSuffix("queueButton") { sawQueueButton = true }
    if let role = node.role, leafRoles.contains(role) { continue }
    guard let children = node.children else {
      failed = true
      continue
    }
    pending.append(contentsOf: children)
  }
  return failed ? .inconclusive : .searched(sawQueueButton: sawQueueButton)
}

func readRow<N: Node>(_ row: N) -> QueueRow {
  var texts: [String] = []
  var buttons: [QueueButton] = []
  var level: [N] = [row]
  for _ in 0...3 {
    var next: [N] = []
    for node in level {
      if node.role == "AXStaticText", let text = nonEmpty(node.value) ?? nonEmpty(node.title) { texts.append(text) }
      if node.role == "AXButton" {
        buttons.append(QueueButton(id: node.identifier, label: nonEmpty(node.title) ?? nonEmpty(node.descriptionText)))
        continue
      }
      next.append(contentsOf: node.children ?? [])
    }
    level = next
  }
  if texts.isEmpty, let fallback = nonEmpty(row.descriptionText) ?? nonEmpty(row.title) ?? nonEmpty(row.value) {
    texts.append(fallback)
  }
  return QueueRow(texts: [texts.joined(separator: " ")].filter { !$0.isEmpty }, buttons: buttons)
}

/// Mini Player first: it is where the queue panel was observed. Closed only when every window was
/// searched to the end, a queue button was seen, and no panel was: anything less is unrecognised.
func readQueue<N: Node>(windows: [N]) -> QueueRead {
  let ordered = windows.filter { $0.title == "Mini Player" } + windows.filter { $0.title != "Mini Player" }
  var sawQueueButton = false
  var conclusive = true
  for window in ordered {
    switch searchWindow(window) {
    case .found(let table):
      guard let visible = table.visibleRows else { return QueueRead(kind: "unreadable") }
      let shown = Array(visible.prefix(maxRows))
      return QueueRead(
        kind: "panel",
        rows: shown.map(readRow),
        lastVisibleIndex: shown.last?.index,
        rowCount: table.rowCount
      )
    case .searched(let button):
      sawQueueButton = sawQueueButton || button
    case .inconclusive:
      conclusive = false
    }
  }
  return QueueRead(kind: conclusive && sawQueueButton ? "closed" : "unrecognised")
}
