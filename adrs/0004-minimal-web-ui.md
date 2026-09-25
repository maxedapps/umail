# 0004: A minimal visual design for every browser page

- **Status:** Accepted (2026-09-25)
- **Date:** 2026-09-25
- **Supersedes:** the stylesheet and layout sections of the ADR 0003 plan: serif headings, the burgundy-on-beige palette, the console's top nav plus mailbox aside, and the single narrow column for auth pages. ADR 0003's decisions stay: one server-rendered page system, a TS stylesheet module, the `html` template, and the CSP per page kind.

## Context

The pages ADR 0003 built work, but they look dated. The CSS already uses modern features (layers, nesting, `light-dark()`, oklch, container queries, `:has()`, popover, view transitions). What looks dated is the visual style:

- Georgia serif headings on a beige paper background.
- A filled burgundy button on almost everything.
- A border on every block, and flash messages with a thick left border.
- Navigation in two places: a top nav, and a separate mailbox sidebar on mail pages.

The owner wants a slick, minimal, clean look across every user-facing page, built with modern vanilla CSS. They approved a mockup (version 2) on 2026-09-25: https://claude.ai/artifact/XMd6W4PyEwaqC3VJBUXSH8. A local copy was kept beside this ADR until the implementation landed.

**Constraints that stay:**

- The CSP blocks web fonts and images (`font-src 'none'`, `img-src 'none'`), so icons must be inline SVG.
- Inline style attributes are blocked (`style-src-attr 'none'`).
- The approval, device and notice pages run no script.
- The browser spec requires:
  - controls at least 44px tall on the focus pages;
  - a visible focus ring;
  - no horizontal scroll at 320px;
  - different light and dark colours.

## Decision

1. **A near-neutral design with one accent.**
   - Greys carry a faint tint toward the brand hue.
   - Primary buttons are ink-coloured: black in light mode, white in dark.
   - The brand burgundy stays, sharpened (`oklch(50% 0.17 18)` light, `oklch(71% 0.15 18)` dark). It is used sparingly: the logo, unread dots, focus rings, selected choices and switches.
2. **Space and tone instead of borders.**
   - Borders only on inputs, choice cards and real objects: the message sheet, the composer, dialogs and the sign-in card.
   - The current page is marked by a soft fill. Secondary buttons are soft fills with no outline.
   - At most one filled primary button per view.
3. **System fonts.** A single sans-serif stack at weights 450–650. No serif; addresses in monospace.
4. **One console layout.**
   - A sidebar holds the logo, a "Write" row, and Mail (with the mailboxes nested under it), Mailboxes and Clients. Sign out sits at the bottom.
   - Content pages can add a sticky toolbar.
   - On narrow screens the sidebar becomes a top bar.
   - The top nav and the mailbox aside are deleted.
5. **One focus layout.** Sign-in, consent, device and notice pages use a centred card. The approval page uses a single column.
6. **Inline SVG icons** from one `web/icons.ts`, always next to a visible label or a screen-reader label.
7. **Flash messages:** success messages become a toast that fades out using CSS only. Errors stay inline.
8. **The approval decision stays after the message body.** It is not pinned to the bottom of the screen, so the reviewer passes the body before reaching Approve. This departs from the mockup; the owner agreed on 2026-09-25.

## Alternatives

| Option                                                                  | Why not                                                                                                                                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Simplest: change the colours and fonts in `styles.ts`, keep the markup** | Leaves the double navigation, the bordered lists and the heavy buttons, which are most of what looks dated. The page markup would still need most of the same changes.                                        |
| Serve one variable web font (Inter or Geist) and allow `font-src 'self'` | Sharper on Linux and Windows. It costs a font route, a CSP change and about 100 KB per first load. The owner approved the mockup with system fonts.                                                            |
| A new accent colour                                                     | The icon would need redrawing too; the burgundy already ties the pages to the brand.                                                                                                                          |
| A CSS framework or utility classes                                      | ADR 0003 chose plain modern CSS, and one hand-written stylesheet of this size needs no framework.                                                                                                             |
| An approval decision bar pinned to the bottom of the screen (as in the mockup) | The reviewer could reach Approve without scrolling past the body. The browser spec checks that the decision sits after the body.                                                                              |

## Consequences

- **Every page's markup and the whole stylesheet are rewritten.** The server-rendered tests that match class names change with them.
- **Console controls are denser** (36px) than the focus pages' 44px. The 44px check applies only to login and approval, which keep it.
- **The newer CSS features are progressive enhancements.** The animated `<details>` opening and the scroll-driven toolbar hairline only work in some browsers; elsewhere the page is unchanged, just without the effect.
- **System fonts vary by platform.** Linux gets whatever `system-ui` resolves to.
- **Success messages disappear.** The toast is announced to screen readers (`role="status"`) and then fades out. Errors never fade.
