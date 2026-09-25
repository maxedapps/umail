import { escapeHtmlText } from "./internal/page.ts";

const DISPLAY_WHITESPACE = /\s+/gu;

type ApprovalDecisionMetadataDisplay = {
  readonly value: string;
};

type ApprovalDecisionMetadataFragment = {
  readonly html: string;
};

export function projectApprovalDecisionMetadata(value: string): ApprovalDecisionMetadataDisplay {
  let projection = "";
  let previousWasLineSeparator = false;
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (isBidiControl(codePoint)) {
      continue;
    }
    if (isLineSeparator(codePoint)) {
      if (!previousWasLineSeparator) {
        projection += " ⏎ ";
      }
      previousWasLineSeparator = true;
      continue;
    }
    previousWasLineSeparator = false;
    projection += isOtherControlCharacter(codePoint) ? " " : character;
  }
  const projected = projection.replace(DISPLAY_WHITESPACE, " ").trim();
  return { value: projected };
}

function isBidiControl(codePoint: number): boolean {
  return (
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function isLineSeparator(codePoint: number): boolean {
  return codePoint === 0x0a || codePoint === 0x0d || codePoint === 0x2028 || codePoint === 0x2029;
}

function isOtherControlCharacter(codePoint: number): boolean {
  return (
    codePoint <= 0x08 ||
    (codePoint >= 0x0b && codePoint <= 0x0c) ||
    (codePoint >= 0x0e && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f)
  );
}

export function renderApprovalDecisionText(
  display: ApprovalDecisionMetadataDisplay,
): ApprovalDecisionMetadataFragment {
  return { html: `<bdi dir="auto">${escapeHtmlText(display.value)}</bdi>` };
}

export function renderApprovalDecisionAddress(
  display: ApprovalDecisionMetadataDisplay,
): ApprovalDecisionMetadataFragment {
  return { html: `<bdi dir="ltr">${escapeHtmlText(display.value)}</bdi>` };
}
