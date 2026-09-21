import { normalizeRfcMessageId } from "@umail/api-contract";
import { describe, expect, it } from "vitest";

import { MessageConflictError } from "../../src/account/errors.ts";
import {
  THREADING_ANCESTRY_WORK_BUDGET,
  THREADING_REFERENCE_LIMIT,
  acceptThreadedMessage,
  claimOwnRfcIdentity,
  conversationIsEligible,
  createMemoryThreadingGraph,
  normalizeInboundRfcHeaders,
  selectDirectParentRfc,
  type MemoryThreadingGraph,
  type ThreadingIds,
} from "../../src/account/threading.ts";

describe("parent RFC selection", () => {
  it("prefers a valid In-Reply-To over newer references and skips the own id", () => {
    const parent = requireRfc("<parent@example.com>");
    const newer = requireRfc("<newer@example.com>");
    const older = requireRfc("<older@example.com>");
    const own = requireRfc("<own@example.com>");
    expect(selectDirectParentRfc(parent, [newer, older], own)).toBe(parent);
    expect(selectDirectParentRfc(null, [newer, older], own)).toBe(newer);
    expect(selectDirectParentRfc(own, [newer, older], own)).toBe(newer);
    expect(selectDirectParentRfc(own, [own], own)).toBeNull();
  });

  it("drops malformed RFC tokens while preserving case-sensitive ids", () => {
    const headers = normalizeInboundRfcHeaders(
      "<Own@example.com>",
      "not-an-id",
      "<First@example.com> <first@example.com> <<<broken@example.com>",
    );
    expect(headers.rfcMessageId).toBe("<Own@example.com>");
    expect(headers.inReplyTo).toBeNull();
    expect(headers.referencesOldestFirst).toEqual(["<First@example.com>", "<first@example.com>"]);
  });
});

describe("account-store threading model", () => {
  it("creates a placeholder for a missing parent and fills it without moving descendants", () => {
    const { graph, ids } = session();
    const child = persist(graph, ids, {
      messageId: "child",
      rfcMessageId: "<child@example.com>",
      inReplyToHeader: "<parent@example.com>",
    });
    expect(graph.nodeKind(child.nodeId)).toBe("message");
    expect(child.parentNodeId).not.toBeNull();
    expect(graph.nodeKind(child.parentNodeId ?? "")).toBe("placeholder");
    const childParent = child.parentNodeId;

    const parent = persist(graph, ids, {
      messageId: "parent",
      rfcMessageId: "<parent@example.com>",
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    expect(parent.nodeId).toBe(childParent);
    expect(parent.claimedRfcMessageId).toBe("<parent@example.com>");
    expect(graph.nodeKind(parent.nodeId)).toBe("message");
    expect(graph.getParent(child.nodeId)).toBe(parent.nodeId);
    expect(sorted(graph.componentMessageIds(child.nodeId))).toEqual(["child", "parent"]);
    expect(sorted(graph.componentMessageIds(parent.nodeId))).toEqual(["child", "parent"]);
  });

  it("completes a parent edge when the child is already in the same component", () => {
    const { graph, ids } = session();
    const child = persist(graph, ids, {
      messageId: "child",
      rfcMessageId: "<child@example.com>",
      inReplyToHeader: "<parent@example.com>",
    });
    expect(graph.findRoot(child.nodeId).root).toBe(graph.findRoot(child.parentNodeId ?? "").root);
    const parent = persist(graph, ids, {
      messageId: "parent",
      rfcMessageId: "<parent@example.com>",
    });
    expect(graph.getParent(child.nodeId)).toBe(parent.nodeId);
    expect(sorted(graph.componentMessageIds(parent.nodeId))).toEqual(["child", "parent"]);
  });

  it("gives the first committed claimant the RFC lookup and keeps a later duplicate independent", () => {
    const { graph, ids } = session();
    const first = persist(graph, ids, {
      messageId: "first",
      rfcMessageId: "<dup@example.com>",
    });
    const second = persist(graph, ids, {
      messageId: "second",
      rfcMessageId: "<dup@example.com>",
      occurredAt: "2026-01-01T00:00:01.000Z",
    });
    expect(first.claimedRfcMessageId).toBe("<dup@example.com>");
    expect(second.claimedRfcMessageId).toBeNull();
    expect(second.nodeId).not.toBe(first.nodeId);
    expect(second.parentNodeId).toBeNull();
    expect(graph.componentMessageIds(first.nodeId)).toEqual(["first"]);
    expect(graph.componentMessageIds(second.nodeId)).toEqual(["second"]);
    const lookup = graph.getRfcLookup(requireRfc("<dup@example.com>"));
    expect(lookup?.claimantNodeId).toBe(first.nodeId);
    expect(lookup?.nodeId).toBe(first.nodeId);
  });

  it("does not let a duplicate join through its own Message-ID even as In-Reply-To", () => {
    const { graph, ids } = session();
    const original = persist(graph, ids, {
      messageId: "original",
      rfcMessageId: "<dup@example.com>",
    });
    const copy = persist(graph, ids, {
      messageId: "copy",
      rfcMessageId: "<dup@example.com>",
      inReplyToHeader: "<dup@example.com>",
    });
    expect(copy.parentNodeId).toBeNull();
    expect(graph.componentMessageIds(copy.nodeId)).toEqual(["copy"]);
    expect(graph.componentMessageIds(original.nodeId)).toEqual(["original"]);
  });

  it("still uses independent parent evidence on a duplicate RFC id", () => {
    const { graph, ids } = session();
    persist(graph, ids, {
      messageId: "root",
      rfcMessageId: "<root@example.com>",
    });
    persist(graph, ids, {
      messageId: "original",
      rfcMessageId: "<dup@example.com>",
    });
    const copy = persist(graph, ids, {
      messageId: "copy",
      rfcMessageId: "<dup@example.com>",
      inReplyToHeader: "<root@example.com>",
    });
    expect(copy.claimedRfcMessageId).toBeNull();
    expect(sorted(graph.componentMessageIds(copy.nodeId))).toEqual(["copy", "root"]);
    expect(
      graph.componentMessageIds(graph.getRfcLookup(requireRfc("<dup@example.com>"))?.nodeId ?? ""),
    ).toEqual(["original"]);
  });

  it("ignores a cycling parent edge, keeps the message, and records a diagnostic", () => {
    const { graph, ids } = session();
    const first = persist(graph, ids, {
      messageId: "a",
      rfcMessageId: "<a@example.com>",
      inReplyToHeader: "<b@example.com>",
    });
    const second = persist(graph, ids, {
      messageId: "b",
      rfcMessageId: "<b@example.com>",
      inReplyToHeader: "<a@example.com>",
    });
    expect(second.nodeId).toBe(first.parentNodeId);
    expect(second.parentNodeId).toBeNull();
    expect(second.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(["parent_cycle"]);
    expect(sorted(graph.componentMessageIds(first.nodeId))).toEqual(["a", "b"]);
    expect(
      graph
        .messages()
        .map((message) => message.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("attaches concurrent descendants to the same missing parent", () => {
    const { graph, ids } = session();
    const childA = persist(graph, ids, {
      messageId: "child-a",
      rfcMessageId: "<child-a@example.com>",
      inReplyToHeader: "<parent@example.com>",
    });
    const childB = persist(graph, ids, {
      messageId: "child-b",
      rfcMessageId: "<child-b@example.com>",
      inReplyToHeader: "<parent@example.com>",
      occurredAt: "2026-01-01T00:00:01.000Z",
    });
    expect(childA.parentNodeId).toBe(childB.parentNodeId);
    const parent = persist(graph, ids, {
      messageId: "parent",
      rfcMessageId: "<parent@example.com>",
    });
    expect(parent.nodeId).toBe(childA.parentNodeId);
    expect(sorted(graph.componentMessageIds(parent.nodeId))).toEqual([
      "child-a",
      "child-b",
      "parent",
    ]);
  });

  it("keeps a child's node handle stable after the parent arrives", () => {
    const { graph, ids } = session();
    const child = persist(graph, ids, {
      messageId: "child",
      rfcMessageId: "<child@example.com>",
      inReplyToHeader: "<parent@example.com>",
    });
    const handleNode = child.nodeId;
    persist(graph, ids, {
      messageId: "parent",
      rfcMessageId: "<parent@example.com>",
    });
    expect(sorted(graph.componentMessageIds(handleNode))).toEqual(["child", "parent"]);
  });

  it("does not coalesce distinct copies merely because Message-ID matches", () => {
    const { graph, ids } = session();
    const outbound = persist(graph, ids, {
      messageId: "out-1",
      direction: "outbound",
      rfcMessageId: "<out-1@cf.example>",
    });
    const inbound = persist(graph, ids, {
      messageId: "in-copy",
      rfcMessageId: "<out-1@cf.example>",
      occurredAt: "2026-01-01T00:00:01.000Z",
    });
    expect(inbound.nodeId).not.toBe(outbound.nodeId);
    expect(graph.componentMessageIds(outbound.nodeId)).toEqual(["out-1"]);
    expect(graph.componentMessageIds(inbound.nodeId)).toEqual(["in-copy"]);
  });

  it("leaves a message independently addressable when ancestry work exceeds the budget", () => {
    const { graph, ids } = session();
    persist(graph, ids, { messageId: "m1", rfcMessageId: "<m1@example.com>" }, 3);
    persist(
      graph,
      ids,
      {
        messageId: "m2",
        rfcMessageId: "<m2@example.com>",
        inReplyToHeader: "<m1@example.com>",
      },
      3,
    );
    persist(
      graph,
      ids,
      {
        messageId: "m3",
        rfcMessageId: "<m3@example.com>",
        inReplyToHeader: "<m2@example.com>",
      },
      3,
    );
    persist(
      graph,
      ids,
      {
        messageId: "m4",
        rfcMessageId: "<m4@example.com>",
        inReplyToHeader: "<m3@example.com>",
      },
      3,
    );
    const limited = persist(
      graph,
      ids,
      {
        messageId: "m5",
        rfcMessageId: "<m5@example.com>",
        inReplyToHeader: "<m4@example.com>",
      },
      3,
    );
    expect(limited.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(["threading_limited"]);
    expect(limited.parentNodeId).toBeNull();
    expect(graph.componentMessageIds(limited.nodeId)).toEqual(["m5"]);
    expect(sorted(graph.componentMessageIds(graph.messages()[0]?.nodeId ?? ""))).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
  });

  it("does not join a parent when inbound References exceed the stored limit", () => {
    const { graph, ids } = session();
    persist(graph, ids, { messageId: "parent", rfcMessageId: "<parent@example.com>" });
    const older: Array<string> = [];
    for (let index = 0; index < THREADING_REFERENCE_LIMIT + 1; index += 1) {
      older.push(`<old-${String(index)}@example.com>`);
    }
    const limited = persist(graph, ids, {
      messageId: "child",
      rfcMessageId: "<child@example.com>",
      inReplyToHeader: "<parent@example.com>",
      referencesHeader: `${older.join(" ")} <parent@example.com>`,
    });
    expect(limited.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(["threading_limited"]);
    expect(limited.parentNodeId).toBeNull();
    expect(graph.componentMessageIds(limited.nodeId)).toEqual(["child"]);
    expect(graph.componentMessageIds(graph.messages()[0]?.nodeId ?? "")).toEqual(["parent"]);
  });

  it("does not join a parent when extra RFC lookups exceed the ancestry budget", () => {
    const { graph, ids } = session();
    persist(graph, ids, { messageId: "parent", rfcMessageId: "<parent@example.com>" });
    const limited = persist(
      graph,
      ids,
      {
        messageId: "child",
        rfcMessageId: "<child@example.com>",
        inReplyToHeader: "<parent@example.com>",
        referencesHeader: "<e1@example.com> <e2@example.com> <parent@example.com>",
      },
      1,
    );
    expect(limited.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(["threading_limited"]);
    expect(limited.parentNodeId).toBeNull();
    expect(graph.componentMessageIds(limited.nodeId)).toEqual(["child"]);
    expect(graph.componentMessageIds(graph.messages()[0]?.nodeId ?? "")).toEqual(["parent"]);
  });

  it("ignores a contradictory parent replacement and retains the established edge", () => {
    const { graph, ids } = session();
    const child = persist(graph, ids, {
      messageId: "child",
      rfcMessageId: "<child@example.com>",
      inReplyToHeader: "<parent@example.com>",
    });
    const placeholder = child.parentNodeId;
    expect(placeholder).not.toBeNull();
    graph.createNode("other", "message", "2026-01-01T00:00:00.000Z");
    graph.setParent(placeholder ?? "", "other");
    const filled = persist(graph, ids, {
      messageId: "parent",
      rfcMessageId: "<parent@example.com>",
      inReplyToHeader: "<newer@example.com>",
    });
    expect(filled.nodeId).toBe(placeholder);
    expect(filled.parentNodeId).toBe("other");
    expect(filled.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(["parent_replacement"]);
    expect(graph.getParent(child.nodeId)).toBe(placeholder);
  });

  it("rejects a duplicate message id without adding a later placeholder", () => {
    const { graph, ids } = session();
    persist(graph, ids, {
      messageId: "same",
      rfcMessageId: "<first@example.com>",
    });
    expect(() =>
      persist(graph, ids, {
        messageId: "same",
        rfcMessageId: "<second@example.com>",
        inReplyToHeader: "<missing@example.com>",
      }),
    ).toThrow(MessageConflictError);
    expect(graph.getRfcLookup(requireRfc("<missing@example.com>"))).toBeNull();
    expect(graph.messages().map((message) => message.id)).toEqual(["same"]);
  });

  it("treats a conversation as eligible when it contains an authorized live mailbox message", () => {
    const messages = [
      { mailboxId: "mbox-1", deletedAt: null },
      { mailboxId: "mbox-2", deletedAt: null },
      { mailboxId: "mbox-2", deletedAt: "2026-01-02T00:00:00.000Z" },
    ];
    expect(conversationIsEligible(messages, "all")).toBe(true);
    expect(conversationIsEligible(messages, ["mbox-1"])).toBe(true);
    expect(conversationIsEligible(messages, ["mbox-3"])).toBe(false);
    expect(conversationIsEligible(messages, [])).toBe(false);
    expect(
      conversationIsEligible(
        [{ mailboxId: "mbox-1", deletedAt: "2026-01-02T00:00:00.000Z" }],
        ["mbox-1"],
      ),
    ).toBe(false);
  });

  it("never leaves a committed message unreachable from its resolved component", () => {
    const { graph, ids } = session();
    persist(graph, ids, {
      messageId: "child",
      mailboxId: "mbox-1",
      rfcMessageId: "<child@example.com>",
      inReplyToHeader: "<parent@example.com>",
    });
    persist(graph, ids, {
      messageId: "other",
      mailboxId: "mbox-2",
      rfcMessageId: "<other@example.com>",
    });
    persist(graph, ids, {
      messageId: "parent",
      mailboxId: "mbox-1",
      rfcMessageId: "<parent@example.com>",
    });
    persist(graph, ids, {
      messageId: "dup",
      mailboxId: "mbox-1",
      rfcMessageId: "<parent@example.com>",
    });
    for (const message of graph.messages()) {
      expect(graph.componentMessageIds(message.nodeId)).toContain(message.id);
    }
    expect(THREADING_ANCESTRY_WORK_BUDGET).toBeGreaterThan(8);
  });
});

describe("late RFC identity claim", () => {
  it("claims an unseen id onto the sent message so a later reply lands on it", () => {
    const { graph, ids } = session();
    const provider = requireRfc("<provider@cf.example>");
    const sent = persist(graph, ids, {
      messageId: "sent",
      direction: "outbound",
      rfcMessageId: null,
    });

    const claim = claimOwnRfcIdentity(graph, { nodeId: sent.nodeId, rfcMessageId: provider });
    expect(claim).toEqual({ claimed: true, adoptedPlaceholderNodeId: null });
    expect(graph.getRfcLookup(provider)).toEqual({
      rfcMessageId: provider,
      nodeId: sent.nodeId,
      claimantNodeId: sent.nodeId,
    });

    const reply = persist(graph, ids, {
      messageId: "reply",
      rfcMessageId: "<reply@example.com>",
      inReplyToHeader: "<provider@cf.example>",
      occurredAt: "2026-01-01T00:00:01.000Z",
    });
    expect(reply.parentNodeId).toBe(sent.nodeId);
    expect(sorted(graph.componentMessageIds(sent.nodeId))).toEqual(["reply", "sent"]);
  });

  it("adopts an unclaimed placeholder, carrying its children without losing its own parent", () => {
    const { graph, ids } = session();
    const provider = requireRfc("<provider@cf.example>");
    const sent = persist(graph, ids, {
      messageId: "sent",
      direction: "outbound",
      rfcMessageId: null,
      inReplyToHeader: "<original@example.com>",
    });
    const ownParentNodeId = graph.getParent(sent.nodeId);
    expect(ownParentNodeId).not.toBeNull();

    const early = persist(graph, ids, {
      messageId: "early-reply",
      rfcMessageId: "<early@example.com>",
      inReplyToHeader: "<provider@cf.example>",
      occurredAt: "2026-01-01T00:00:01.000Z",
    });
    const placeholderNodeId = early.parentNodeId;
    expect(placeholderNodeId).not.toBeNull();
    expect(graph.componentMessageIds(sent.nodeId)).toEqual(["sent"]);

    const claim = claimOwnRfcIdentity(graph, { nodeId: sent.nodeId, rfcMessageId: provider });
    expect(claim).toEqual({ claimed: true, adoptedPlaceholderNodeId: placeholderNodeId });
    expect(graph.getParent(early.nodeId)).toBe(sent.nodeId);
    expect(graph.getParent(sent.nodeId)).toBe(ownParentNodeId);
    expect(sorted(graph.componentMessageIds(sent.nodeId))).toEqual(["early-reply", "sent"]);
    expect(graph.getRfcLookup(provider)).toEqual({
      rfcMessageId: provider,
      nodeId: sent.nodeId,
      claimantNodeId: sent.nodeId,
    });
    if (placeholderNodeId === null) {
      throw new Error("expected a placeholder node");
    }
    expect(graph.findRoot(placeholderNodeId).root).toBe(graph.findRoot(sent.nodeId).root);
  });

  it("leaves a lookup that already has a claimant untouched", () => {
    const { graph, ids } = session();
    const provider = requireRfc("<provider@cf.example>");
    const first = persist(graph, ids, {
      messageId: "first",
      rfcMessageId: "<provider@cf.example>",
    });
    const sent = persist(graph, ids, {
      messageId: "sent",
      direction: "outbound",
      rfcMessageId: null,
      occurredAt: "2026-01-01T00:00:01.000Z",
    });

    const claim = claimOwnRfcIdentity(graph, { nodeId: sent.nodeId, rfcMessageId: provider });
    expect(claim).toEqual({ claimed: false, adoptedPlaceholderNodeId: null });
    expect(graph.getRfcLookup(provider)).toEqual({
      rfcMessageId: provider,
      nodeId: first.nodeId,
      claimantNodeId: first.nodeId,
    });
    expect(graph.componentMessageIds(sent.nodeId)).toEqual(["sent"]);
  });
});

function session() {
  let nodes = 0;
  let diagnostics = 0;
  return {
    graph: createMemoryThreadingGraph(),
    ids: {
      nodeId: () => `node-${String(++nodes)}`,
      diagnosticId: () => `diag-${String(++diagnostics)}`,
    },
  };
}

function persist(
  graph: MemoryThreadingGraph,
  ids: ThreadingIds,
  fields: {
    readonly messageId: string;
    readonly mailboxId?: string;
    readonly direction?: "inbound" | "outbound";
    readonly rfcMessageId: string | null;
    readonly inReplyToHeader?: string | null;
    readonly referencesHeader?: string | null;
    readonly occurredAt?: string;
  },
  budget: number = THREADING_ANCESTRY_WORK_BUDGET,
) {
  const inReplyToHeader = fields.inReplyToHeader === undefined ? null : fields.inReplyToHeader;
  const headers = normalizeInboundRfcHeaders(
    fields.rfcMessageId,
    inReplyToHeader,
    fields.referencesHeader === undefined ? inReplyToHeader : fields.referencesHeader,
  );
  const occurredAt = fields.occurredAt ?? "2026-01-01T00:00:00.000Z";
  return acceptThreadedMessage(
    graph,
    {
      messageId: fields.messageId,
      mailboxId: fields.mailboxId ?? "mbox-1",
      direction: fields.direction ?? "inbound",
      rfcMessageId: headers.rfcMessageId,
      inReplyTo: headers.inReplyTo,
      referencesOldestFirst: headers.referencesOldestFirst,
      referencesTruncated: headers.referencesTruncated,
      occurredAt,
      nowIso: occurredAt,
    },
    ids,
    budget,
  );
}

function requireRfc(raw: string) {
  const normalized = normalizeRfcMessageId(raw);
  if (normalized === null) {
    throw new Error(`expected RFC id ${raw}`);
  }
  return normalized;
}

function sorted(ids: ReadonlyArray<string>): string[] {
  return [...ids].sort();
}
