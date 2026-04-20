/**
 * CDP-based accessibility snapshot with stable uid annotations.
 *
 * Uses Accessibility.getFullAXTree to get the browser's real a11y tree,
 * assigns short uids (e.g. "e12") to each interactive/named node, and
 * maintains a uid→backendNodeId map so later interactions can resolve
 * a uid back to a concrete DOM element.
 *
 * Cross-origin (OOPIF) iframes have their own CDP target. We pull each
 * one's tree separately and splice it in at the parent iframe node,
 * tagging the frame's uids with a targetId so interaction handlers can
 * route clicks/type/etc. to the right session.
 */

import type { DebuggerManager } from "./debugger-manager.js";

export interface UidEntry {
  backendNodeId: number;
  role: string;
  name: string;
  /** undefined = main tab frame; otherwise the OOPIF's CDP targetId. */
  targetId?: string;
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

interface FrameSubtree {
  /** backendNodeId of the iframe ELEMENT in the parent document. */
  ownerBackendNodeId: number;
  targetId: string;
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
  // Refresh OOPIF attachments — new iframes since the last snapshot
  // need to be discovered, and old ones cleaned up.
  await mgr.syncFrameTargets(tabId).catch(() => {});

  await mgr.sendCommand(tabId, "Accessibility.enable", {});
  const main = await mgr.sendCommand<AXTreeResult>(tabId, "Accessibility.getFullAXTree", {});

  // Pull every OOPIF subtree and key it by the backendNodeId of its owning
  // iframe in the parent document.
  const frameTrees: FrameSubtree[] = [];
  for (const f of mgr.getFrameTargets(tabId)) {
    try {
      const owner = await mgr.sendCommand<{ backendNodeId: number }>(
        tabId,
        "DOM.getFrameOwner",
        { frameId: f.targetId },
      );
      const sub = await mgr.sendCommand<AXTreeResult>(
        tabId,
        "Accessibility.getFullAXTree",
        {},
        f.targetId,
      );
      frameTrees.push({
        ownerBackendNodeId: owner.backendNodeId,
        targetId: f.targetId,
        nodes: sub.nodes,
      });
    } catch {
      // Frame vanished between syncFrameTargets and here, or a11y isn't
      // ready yet. Skip this one — the parent tree will still render it
      // as an opaque iframe node.
    }
  }

  const frameByOwner = new Map<number, FrameSubtree>();
  for (const sub of frameTrees) frameByOwner.set(sub.ownerBackendNodeId, sub);

  const uidMap = new Map<string, UidEntry>();
  const lines: string[] = [];
  let totalLen = 0;
  let truncated = false;

  function walkTree(nodes: AXNode[], rootDepth: number, targetId?: string): void {
    if (truncated) return;
    const nodeMap = new Map<string, AXNode>();
    for (const n of nodes) nodeMap.set(n.nodeId, n);
    const root = nodes.find((n) => !n.parentId) ?? nodes[0];
    if (!root) return;

    function walk(nodeId: string, depth: number): void {
      if (truncated) return;
      const node = nodeMap.get(nodeId);
      if (!node) return;

      const role = node.role?.value ?? "";
      if (SKIP_ROLES.has(role) && !node.childIds?.length) return;

      let childrenDepth = depth;
      if (isInteresting(node) && node.backendDOMNodeId) {
        const uid = nextUid();
        const name = (node.name?.value ?? "").trim();
        uidMap.set(uid, {
          backendNodeId: node.backendDOMNodeId,
          role,
          name,
          targetId,
        });

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
        childrenDepth = depth + 1;
      }

      // If this node is the owning iframe of an OOPIF, dive into the
      // frame's tree at the next depth instead of recursing into the
      // (empty) iframe children in the parent document.
      if (
        !targetId &&
        node.backendDOMNodeId !== undefined &&
        frameByOwner.has(node.backendDOMNodeId)
      ) {
        const sub = frameByOwner.get(node.backendDOMNodeId)!;
        walkTree(sub.nodes, childrenDepth, sub.targetId);
        return;
      }

      const kids = node.childIds ?? [];
      for (const kid of kids) {
        if (truncated) break;
        walk(kid, childrenDepth);
      }
    }

    walk(root.nodeId, rootDepth);
  }

  walkTree(main.nodes, 0, undefined);
  tabUidMaps.set(tabId, uidMap);

  return { content: lines.join("\n"), truncated };
}
