/**
 * CDP-based accessibility snapshot with stable uid annotations.
 *
 * Uses Accessibility.getFullAXTree to get the browser's real a11y tree,
 * assigns short uids (e.g. "e12") to each interactive/named node, and
 * maintains a uid→backendNodeId map so later interactions can resolve
 * a uid back to a concrete DOM element.
 */

import type { DebuggerManager } from "./debugger-manager.js";

export interface UidEntry {
  backendNodeId: number;
  role: string;
  name: string;
}

/** Per-tab uid map. Cleared on each new snapshot. */
const tabUidMaps = new Map<number, Map<string, UidEntry>>();
let uidCounter = 0;

function nextUid(): string {
  return `e${uidCounter++}`;
}

/** Resolve a uid to a backendNodeId for the given tab. */
export function resolveUid(tabId: number, uid: string): UidEntry | undefined {
  return tabUidMaps.get(tabId)?.get(uid);
}

/** Clear uid map for a tab (e.g. on tab close). */
export function clearUidMap(tabId: number): void {
  tabUidMaps.delete(tabId);
}

// Roles that are always "interesting" even without a name.
const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox",
  "checkbox", "radio", "switch", "slider", "spinbutton",
  "menuitem", "menuitemcheckbox", "menuitemradio",
  "tab", "treeitem", "option", "listitem",
  "textField", "TextField",
]);

// Roles to skip entirely (layout/container noise).
const SKIP_ROLES = new Set([
  "none", "presentation", "generic", "InlineTextBox",
  "LineBreak",
]);

interface AXNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  properties?: Array<{ name: string; value: { type: string; value: unknown } }>;
  childIds?: string[];
  ignored?: boolean;
  parentId?: string;
}

interface AXTreeResult {
  nodes: AXNode[];
}

function getProp(node: AXNode, propName: string): unknown {
  const p = node.properties?.find((x) => x.name === propName);
  return p?.value?.value;
}

function isInteresting(node: AXNode): boolean {
  if (node.ignored) return false;
  const role = node.role?.value ?? "";
  if (SKIP_ROLES.has(role)) return false;
  if (INTERACTIVE_ROLES.has(role)) return true;
  // Has a meaningful name?
  const name = (node.name?.value ?? "").trim();
  if (name.length > 0) return true;
  // Has focusable/editable property?
  if (getProp(node, "focusable") === true) return true;
  return false;
}

export async function captureA11ySnapshot(
  mgr: DebuggerManager,
  tabId: number,
  maxBytes: number,
): Promise<{ content: string; truncated: boolean }> {
  // Ensure debugger is attached (enables Accessibility domain).
  await mgr.sendCommand(tabId, "Accessibility.enable", {});

  const result = await mgr.sendCommand<AXTreeResult>(tabId, "Accessibility.getFullAXTree", {});
  const nodes = result.nodes;

  // Build parent→children and nodeId→node maps.
  const nodeMap = new Map<string, AXNode>();
  const childrenMap = new Map<string, string[]>();
  for (const n of nodes) {
    nodeMap.set(n.nodeId, n);
    if (n.childIds) {
      childrenMap.set(n.nodeId, n.childIds);
    }
  }

  // Find root.
  const root = nodes.find((n) => !n.parentId) ?? nodes[0];
  if (!root) return { content: "", truncated: false };

  // Build uid map and render tree.
  const uidMap = new Map<string, UidEntry>();
  const lines: string[] = [];
  let totalLen = 0;
  let truncated = false;

  function walk(nodeId: string, depth: number) {
    if (truncated) return;
    const node = nodeMap.get(nodeId);
    if (!node) return;

    const role = node.role?.value ?? "";
    if (SKIP_ROLES.has(role) && !node.childIds?.length) return;

    if (isInteresting(node) && node.backendDOMNodeId) {
      const uid = nextUid();
      const name = (node.name?.value ?? "").trim();
      uidMap.set(uid, {
        backendNodeId: node.backendDOMNodeId,
        role,
        name,
      });

      // Build attribute string.
      const attrs: string[] = [];
      if (getProp(node, "focusable") === true) attrs.push("focusable");
      if (getProp(node, "disabled") === true) attrs.push("disabled");
      if (getProp(node, "checked") === true) attrs.push("checked");
      if (getProp(node, "selected") === true) attrs.push("selected");
      if (getProp(node, "expanded") === true) attrs.push("expanded");
      if (getProp(node, "expanded") === false) attrs.push("collapsed");
      if (getProp(node, "required") === true) attrs.push("required");
      if (getProp(node, "readonly") === true) attrs.push("readonly");
      const val = getProp(node, "value");
      if (val !== undefined && val !== "") attrs.push(`value="${String(val).slice(0, 80)}"`);

      const indent = "  ".repeat(depth);
      const nameStr = name ? ` "${name.slice(0, 100)}"` : "";
      const attrStr = attrs.length ? ` ${attrs.join(" ")}` : "";
      const line = `${indent}[${uid}] ${role}${nameStr}${attrStr}`;

      totalLen += line.length + 1;
      if (totalLen > maxBytes) {
        truncated = true;
        return;
      }
      lines.push(line);
    }

    // Recurse into children.
    const kids = childrenMap.get(nodeId) ?? node.childIds ?? [];
    for (const kid of kids) {
      if (truncated) break;
      walk(kid, isInteresting(node) ? depth + 1 : depth);
    }
  }

  walk(root.nodeId, 0);
  tabUidMaps.set(tabId, uidMap);

  return { content: lines.join("\n"), truncated };
}
