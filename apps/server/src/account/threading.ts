import {
  normalizeRfcMessageId,
  normalizeRfcMessageIdList,
  type NormalizedRfcMessageId,
} from "@umail/api-contract";

import { AccountStoreUnexpectedError, MessageConflictError } from "./errors.ts";

export const THREADING_ANCESTRY_WORK_BUDGET = 256 as const;
export const THREADING_REFERENCE_LIMIT = 128 as const;

export const threadingDiagnosticKinds = [
  "parent_cycle",
  "parent_replacement",
  "threading_limited",
] as const;
export type ThreadingDiagnosticKind = (typeof threadingDiagnosticKinds)[number];

export const threadNodeKinds = ["placeholder", "message"] as const;
export type ThreadNodeKind = (typeof threadNodeKinds)[number];

export const messageDirections = ["inbound", "outbound"] as const;
export type MessageDirection = (typeof messageDirections)[number];

export type RfcLookupRecord = {
  readonly rfcMessageId: NormalizedRfcMessageId;
  readonly nodeId: string;
  readonly claimantNodeId: string | null;
};

export type ThreadNodeRecord = {
  readonly id: string;
  readonly kind: ThreadNodeKind;
};

export type ThreadMessageRecord = {
  readonly id: string;
  readonly nodeId: string;
  readonly mailboxId: string;
  readonly direction: MessageDirection;
  readonly rfcMessageId: NormalizedRfcMessageId | null;
  readonly inReplyToRfcMessageId: NormalizedRfcMessageId | null;
  readonly occurredAt: string;
  readonly createdAt: string;
  readonly deletedAt: string | null;
};

export type ThreadingDiagnosticRecord = {
  readonly id: string;
  readonly messageId: string;
  readonly nodeId: string;
  readonly kind: ThreadingDiagnosticKind;
  readonly detail: string;
  readonly createdAt: string;
};

export type FindRootResult = {
  readonly root: string;
  readonly hops: number;
};

export type BoundedRfcReferences = {
  readonly referencesOldestFirst: ReadonlyArray<NormalizedRfcMessageId>;
  readonly truncated: boolean;
};

export type NormalizedInboundRfcHeaders = {
  readonly rfcMessageId: NormalizedRfcMessageId | null;
  readonly inReplyTo: NormalizedRfcMessageId | null;
  readonly referencesOldestFirst: ReadonlyArray<NormalizedRfcMessageId>;
  readonly referencesTruncated: boolean;
};

type OwnNodeClaim = {
  readonly nodeId: string;
  readonly claimed: boolean;
};

type SemanticParentWalk = {
  readonly cycle: boolean;
  readonly hops: number;
  readonly limited: boolean;
};

export interface ThreadingGraph {
  hasMessage(messageId: string): boolean;
  getRfcLookup(rfcId: NormalizedRfcMessageId): RfcLookupRecord | null;
  getParent(nodeId: string): string | null;
  findRoot(nodeId: string): FindRootResult;
  createNode(nodeId: string, kind: ThreadNodeKind, nowIso: string): void;
  fillPlaceholder(nodeId: string): void;
  putRfcLookup(rfcId: NormalizedRfcMessageId, nodeId: string, claimantNodeId: string | null): void;
  setParent(childNodeId: string, parentNodeId: string): void;
  repointChildren(fromNodeId: string, toNodeId: string): void;
  union(nodeA: string, nodeB: string): number;
  addMessage(message: ThreadMessageRecord): void;
  addReferences(
    messageId: string,
    referencesOldestFirst: ReadonlyArray<NormalizedRfcMessageId>,
  ): void;
  addDiagnostic(diagnostic: ThreadingDiagnosticRecord): void;
}

export type ThreadingIds = {
  readonly nodeId: () => string;
  readonly diagnosticId: () => string;
};

export type AcceptThreadedMessageInput = {
  readonly messageId: string;
  readonly mailboxId: string;
  readonly direction: MessageDirection;
  readonly rfcMessageId: NormalizedRfcMessageId | null;
  readonly inReplyTo: NormalizedRfcMessageId | null;
  readonly referencesOldestFirst: ReadonlyArray<NormalizedRfcMessageId>;
  readonly referencesTruncated: boolean;
  readonly occurredAt: string;
  readonly nowIso: string;
};

export type AcceptThreadedMessageResult = {
  readonly messageId: string;
  readonly nodeId: string;
  readonly componentRootId: string;
  readonly claimedRfcMessageId: NormalizedRfcMessageId | null;
  readonly parentNodeId: string | null;
  readonly diagnostics: ReadonlyArray<ThreadingDiagnosticRecord>;
};

export type MailboxVisibilityScope = "all" | ReadonlyArray<string>;

export type ConversationEligibilityMessage = {
  readonly mailboxId: string;
  readonly deletedAt: string | null;
};

export function cryptoThreadingIds(): ThreadingIds {
  return {
    nodeId: () => crypto.randomUUID(),
    diagnosticId: () => crypto.randomUUID(),
  };
}

export function boundReferencesOldestFirst(
  referencesOldestFirst: ReadonlyArray<NormalizedRfcMessageId>,
  limit: number = THREADING_REFERENCE_LIMIT,
): BoundedRfcReferences {
  if (referencesOldestFirst.length <= limit) {
    return { referencesOldestFirst, truncated: false };
  }
  return {
    referencesOldestFirst: referencesOldestFirst.slice(referencesOldestFirst.length - limit),
    truncated: true,
  };
}

export function normalizeInboundRfcHeaders(
  rfcMessageId: string | null,
  inReplyToHeader: string | null,
  referencesHeader: string | null,
): NormalizedInboundRfcHeaders {
  const unboundedReferences =
    referencesHeader === null ? [] : normalizeRfcMessageIdList(referencesHeader);
  const bounded = boundReferencesOldestFirst(unboundedReferences);
  return {
    rfcMessageId: rfcMessageId === null ? null : normalizeRfcMessageId(rfcMessageId),
    inReplyTo: inReplyToHeader === null ? null : normalizeRfcMessageId(inReplyToHeader),
    referencesOldestFirst: bounded.referencesOldestFirst,
    referencesTruncated: bounded.truncated,
  };
}

export function selectDirectParentRfc(
  inReplyTo: NormalizedRfcMessageId | null,
  referencesNewestFirst: ReadonlyArray<NormalizedRfcMessageId>,
  ownRfcId: NormalizedRfcMessageId | null,
): NormalizedRfcMessageId | null {
  if (inReplyTo !== null && inReplyTo !== ownRfcId) {
    return inReplyTo;
  }
  for (const reference of referencesNewestFirst) {
    if (reference !== ownRfcId) {
      return reference;
    }
  }
  return null;
}

export function conversationIsEligible(
  messages: ReadonlyArray<ConversationEligibilityMessage>,
  authorizedMailboxes: MailboxVisibilityScope,
): boolean {
  if (authorizedMailboxes !== "all" && authorizedMailboxes.length === 0) {
    return false;
  }
  for (const message of messages) {
    if (message.deletedAt !== null) {
      continue;
    }
    if (authorizedMailboxes === "all") {
      return true;
    }
    if (mailboxInScope(message.mailboxId, authorizedMailboxes)) {
      return true;
    }
  }
  return false;
}

export function acceptThreadedMessage(
  graph: ThreadingGraph,
  input: AcceptThreadedMessageInput,
  ids: ThreadingIds,
  budget: number = THREADING_ANCESTRY_WORK_BUDGET,
): AcceptThreadedMessageResult {
  if (graph.hasMessage(input.messageId)) {
    throw new MessageConflictError({ messageId: input.messageId });
  }

  const own = claimOrCreateOwnNode(graph, input, ids);
  const diagnostics: Array<ThreadingDiagnosticRecord> = [];
  let limited = input.referencesTruncated;

  const referencesNewestFirst = reverseRfcIds(input.referencesOldestFirst);
  const parentRfc = selectDirectParentRfc(
    input.inReplyTo,
    referencesNewestFirst,
    input.rfcMessageId,
  );
  const referenced = uniqueRfcIds([
    ...(parentRfc === null ? [] : [parentRfc]),
    ...(input.inReplyTo === null ? [] : [input.inReplyTo]),
    ...input.referencesOldestFirst,
  ]);

  let parentNodeId: string | null = null;
  let extraLookups = 0;
  for (const rfcId of referenced) {
    if (rfcId === input.rfcMessageId) {
      continue;
    }
    if (rfcId === parentRfc) {
      parentNodeId = ensureRfcNode(graph, rfcId, ids, input.nowIso);
      continue;
    }
    extraLookups += 1;
    if (extraLookups > budget) {
      limited = true;
      continue;
    }
    ensureRfcNode(graph, rfcId, ids, input.nowIso);
  }

  if (!limited && parentNodeId !== null && parentNodeId !== own.nodeId) {
    const attached = tryAttachParent(graph, own.nodeId, parentNodeId, budget);
    if (attached.limited) {
      limited = true;
    }
    if (attached.kind !== null) {
      diagnostics.push(
        recordDiagnostic(graph, ids, input, own.nodeId, attached.kind, attached.detail),
      );
    }
  }

  graph.addMessage({
    id: input.messageId,
    nodeId: own.nodeId,
    mailboxId: input.mailboxId,
    direction: input.direction,
    rfcMessageId: input.rfcMessageId,
    inReplyToRfcMessageId: input.inReplyTo,
    occurredAt: input.occurredAt,
    createdAt: input.nowIso,
    deletedAt: null,
  });
  graph.addReferences(input.messageId, input.referencesOldestFirst);

  if (limited) {
    diagnostics.push(
      recordDiagnostic(
        graph,
        ids,
        input,
        own.nodeId,
        "threading_limited",
        "Ancestry work exceeded the explicit threading budget",
      ),
    );
  }

  return {
    messageId: input.messageId,
    nodeId: own.nodeId,
    componentRootId: graph.findRoot(own.nodeId).root,
    claimedRfcMessageId: own.claimed ? input.rfcMessageId : null,
    parentNodeId: graph.getParent(own.nodeId),
    diagnostics,
  };
}

export function createMemoryThreadingGraph(): MemoryThreadingGraph {
  const nodes = new Map<string, ThreadNodeRecord>();
  const lookups = new Map<NormalizedRfcMessageId, RfcLookupRecord>();
  const parents = new Map<string, string>();
  const links = new Map<string, MutableComponentLink>();
  const messages = new Map<string, ThreadMessageRecord>();
  const references = new Map<string, ReadonlyArray<NormalizedRfcMessageId>>();
  const diagnostics: Array<ThreadingDiagnosticRecord> = [];

  const graph: MemoryThreadingGraph = {
    hasMessage(messageId) {
      return messages.has(messageId);
    },
    getRfcLookup(rfcId) {
      return lookups.get(rfcId) ?? null;
    },
    getParent(nodeId) {
      return parents.get(nodeId) ?? null;
    },
    findRoot(nodeId) {
      return findMemoryRoot(links, nodeId);
    },
    createNode(nodeId, kind, _nowIso) {
      nodes.set(nodeId, { id: nodeId, kind });
      links.set(nodeId, { parent: nodeId, rank: 0, size: 1 });
    },
    fillPlaceholder(nodeId) {
      nodes.set(nodeId, { id: nodeId, kind: "message" });
    },
    putRfcLookup(rfcId, nodeId, claimantNodeId) {
      lookups.set(rfcId, { rfcMessageId: rfcId, nodeId, claimantNodeId });
    },
    setParent(childNodeId, parentNodeId) {
      parents.set(childNodeId, parentNodeId);
    },
    repointChildren(fromNodeId, toNodeId) {
      for (const [childNodeId, parentNodeId] of parents) {
        if (parentNodeId === fromNodeId && childNodeId !== toNodeId) {
          parents.set(childNodeId, toNodeId);
        }
      }
    },
    union(nodeA, nodeB) {
      return unionMemory(links, nodeA, nodeB);
    },
    addMessage(message) {
      messages.set(message.id, message);
    },
    addReferences(messageId, referencesOldestFirst) {
      references.set(messageId, referencesOldestFirst);
    },
    addDiagnostic(diagnostic) {
      diagnostics.push(diagnostic);
    },
    messages() {
      return [...messages.values()];
    },
    diagnostics() {
      return [...diagnostics];
    },
    rfcLookups() {
      return [...lookups.values()];
    },
    messageReferences(messageId) {
      return references.get(messageId) ?? [];
    },
    nodeKind(nodeId) {
      const node = nodes.get(nodeId);
      return node === undefined ? null : node.kind;
    },
    componentMessageIds(nodeId) {
      const root = findMemoryRoot(links, nodeId).root;
      const ids: Array<string> = [];
      for (const message of messages.values()) {
        if (findMemoryRoot(links, message.nodeId).root === root) {
          ids.push(message.id);
        }
      }
      return ids;
    },
  };
  return graph;
}

export type MemoryThreadingGraph = ThreadingGraph & {
  messages(): ReadonlyArray<ThreadMessageRecord>;
  diagnostics(): ReadonlyArray<ThreadingDiagnosticRecord>;
  rfcLookups(): ReadonlyArray<RfcLookupRecord>;
  messageReferences(messageId: string): ReadonlyArray<NormalizedRfcMessageId>;
  nodeKind(nodeId: string): ThreadNodeKind | null;
  componentMessageIds(nodeId: string): ReadonlyArray<string>;
};

type MutableComponentLink = {
  parent: string;
  rank: number;
  size: number;
};

type AttachAttempt = {
  readonly work: number;
  readonly limited: boolean;
  readonly kind: ThreadingDiagnosticKind | null;
  readonly detail: string;
};

export type OwnRfcIdentityClaim = {
  readonly nodeId: string;
  readonly rfcMessageId: NormalizedRfcMessageId;
};

export type OwnRfcIdentityClaimResult = {
  readonly claimed: boolean;
  readonly adoptedPlaceholderNodeId: string | null;
};

export function claimOwnRfcIdentity(
  graph: ThreadingGraph,
  claim: OwnRfcIdentityClaim,
): OwnRfcIdentityClaimResult {
  const existing = graph.getRfcLookup(claim.rfcMessageId);
  if (existing === null) {
    graph.putRfcLookup(claim.rfcMessageId, claim.nodeId, claim.nodeId);
    return { claimed: true, adoptedPlaceholderNodeId: null };
  }
  if (existing.claimantNodeId !== null) {
    return { claimed: false, adoptedPlaceholderNodeId: null };
  }
  graph.repointChildren(existing.nodeId, claim.nodeId);
  graph.union(claim.nodeId, existing.nodeId);
  graph.putRfcLookup(claim.rfcMessageId, claim.nodeId, claim.nodeId);
  return { claimed: true, adoptedPlaceholderNodeId: existing.nodeId };
}

function claimOrCreateOwnNode(
  graph: ThreadingGraph,
  input: AcceptThreadedMessageInput,
  ids: ThreadingIds,
): OwnNodeClaim {
  if (input.rfcMessageId === null) {
    const nodeId = ids.nodeId();
    graph.createNode(nodeId, "message", input.nowIso);
    return { nodeId, claimed: false };
  }
  const existing = graph.getRfcLookup(input.rfcMessageId);
  if (existing === null) {
    const nodeId = ids.nodeId();
    graph.createNode(nodeId, "message", input.nowIso);
    graph.putRfcLookup(input.rfcMessageId, nodeId, nodeId);
    return { nodeId, claimed: true };
  }
  if (existing.claimantNodeId === null) {
    graph.fillPlaceholder(existing.nodeId);
    graph.putRfcLookup(input.rfcMessageId, existing.nodeId, existing.nodeId);
    return { nodeId: existing.nodeId, claimed: true };
  }
  const nodeId = ids.nodeId();
  graph.createNode(nodeId, "message", input.nowIso);
  return { nodeId, claimed: false };
}

function ensureRfcNode(
  graph: ThreadingGraph,
  rfcId: NormalizedRfcMessageId,
  ids: ThreadingIds,
  nowIso: string,
): string {
  const existing = graph.getRfcLookup(rfcId);
  if (existing !== null) {
    return existing.nodeId;
  }
  const nodeId = ids.nodeId();
  graph.createNode(nodeId, "placeholder", nowIso);
  graph.putRfcLookup(rfcId, nodeId, null);
  return nodeId;
}

function tryAttachParent(
  graph: ThreadingGraph,
  childNodeId: string,
  parentNodeId: string,
  remainingBudget: number,
): AttachAttempt {
  const established = graph.getParent(childNodeId);
  if (established !== null) {
    if (established === parentNodeId) {
      return { work: 0, limited: false, kind: null, detail: "" };
    }
    return {
      work: 0,
      limited: false,
      kind: "parent_replacement",
      detail: "Ignored a contradictory parent edge because a direct parent is already established",
    };
  }

  const walk = walkSemanticParents(graph, parentNodeId, childNodeId, remainingBudget);
  if (walk.limited) {
    return {
      work: walk.hops,
      limited: true,
      kind: null,
      detail: "",
    };
  }
  if (walk.cycle) {
    return {
      work: walk.hops,
      limited: false,
      kind: "parent_cycle",
      detail: "Ignored a parent edge that would introduce a cycle",
    };
  }

  graph.setParent(childNodeId, parentNodeId);
  graph.union(childNodeId, parentNodeId);
  return { work: walk.hops, limited: false, kind: null, detail: "" };
}

function walkSemanticParents(
  graph: ThreadingGraph,
  startNodeId: string,
  targetNodeId: string,
  remainingBudget: number,
): SemanticParentWalk {
  const seen = new Set<string>();
  let current: string | null = startNodeId;
  let hops = 0;
  while (current !== null) {
    hops += 1;
    if (hops > remainingBudget) {
      return { cycle: false, hops, limited: true };
    }
    if (current === targetNodeId) {
      return { cycle: true, hops, limited: false };
    }
    if (seen.has(current)) {
      return { cycle: true, hops, limited: false };
    }
    seen.add(current);
    current = graph.getParent(current);
  }
  return { cycle: false, hops, limited: false };
}

function recordDiagnostic(
  graph: ThreadingGraph,
  ids: ThreadingIds,
  input: AcceptThreadedMessageInput,
  nodeId: string,
  kind: ThreadingDiagnosticKind,
  detail: string,
): ThreadingDiagnosticRecord {
  const diagnostic = {
    id: ids.diagnosticId(),
    messageId: input.messageId,
    nodeId,
    kind,
    detail,
    createdAt: input.nowIso,
  } satisfies ThreadingDiagnosticRecord;
  graph.addDiagnostic(diagnostic);
  return diagnostic;
}

function findMemoryRoot(links: Map<string, MutableComponentLink>, nodeId: string): FindRootResult {
  const path: Array<string> = [];
  const seen = new Set<string>();
  let current = nodeId;
  let hops = 0;
  for (;;) {
    if (seen.has(current)) {
      throw new AccountStoreUnexpectedError({
        cause: `Thread component parent cycle at ${current}`,
      });
    }
    seen.add(current);
    const link = requireLink(links, current);
    hops += 1;
    if (link.parent === current) {
      for (const id of path) {
        requireLink(links, id).parent = current;
      }
      return { root: current, hops };
    }
    path.push(current);
    current = link.parent;
  }
}

function unionMemory(
  links: Map<string, MutableComponentLink>,
  nodeA: string,
  nodeB: string,
): number {
  const foundA = findMemoryRoot(links, nodeA);
  const foundB = findMemoryRoot(links, nodeB);
  if (foundA.root === foundB.root) {
    return foundA.hops + foundB.hops;
  }
  const linkA = requireLink(links, foundA.root);
  const linkB = requireLink(links, foundB.root);
  if (linkA.size > linkB.size || (linkA.size === linkB.size && foundA.root < foundB.root)) {
    linkB.parent = foundA.root;
    linkA.size += linkB.size;
    if (linkA.size - linkB.size === linkB.size) {
      linkA.rank += 1;
    }
  } else {
    linkA.parent = foundB.root;
    linkB.size += linkA.size;
    if (linkB.size - linkA.size === linkA.size) {
      linkB.rank += 1;
    }
  }
  return foundA.hops + foundB.hops;
}

function requireLink(
  links: Map<string, MutableComponentLink>,
  nodeId: string,
): MutableComponentLink {
  const link = links.get(nodeId);
  if (link === undefined) {
    throw new AccountStoreUnexpectedError({
      cause: `Missing thread component link for node ${nodeId}`,
    });
  }
  return link;
}

function uniqueRfcIds(
  ids: ReadonlyArray<NormalizedRfcMessageId>,
): ReadonlyArray<NormalizedRfcMessageId> {
  const seen = new Set<NormalizedRfcMessageId>();
  const unique: Array<NormalizedRfcMessageId> = [];
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    unique.push(id);
  }
  return unique;
}

function reverseRfcIds(
  ids: ReadonlyArray<NormalizedRfcMessageId>,
): ReadonlyArray<NormalizedRfcMessageId> {
  const reversed: Array<NormalizedRfcMessageId> = [];
  for (let index = ids.length - 1; index >= 0; index -= 1) {
    const id = ids[index];
    if (id !== undefined) {
      reversed.push(id);
    }
  }
  return reversed;
}

function mailboxInScope(mailboxId: string, authorizedMailboxes: ReadonlyArray<string>): boolean {
  for (const authorized of authorizedMailboxes) {
    if (authorized === mailboxId) {
      return true;
    }
  }
  return false;
}
