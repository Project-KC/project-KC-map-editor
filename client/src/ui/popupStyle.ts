/**
 * Shared popup styling helpers.
 *
 * EvilQuest's playable canvas area is `calc(100vw - 340px)` wide and
 * `calc(100vh - 220px)` tall — the right 340px is the UI column and the
 * bottom 220px is the chat. All popups must:
 *   - Center inside the canvas area (NOT the whole viewport)
 *   - Size themselves relative to the canvas, not fixed pixels
 *   - Never exceed the canvas bounds on small clients
 *
 * Usage:
 *   el.style.cssText = popupContainerCss({ widthFrac: 0.3 });
 *
 * For finer control, spread `popupGeometryCss()` into your existing CSS.
 */

/** Width/height of the non-canvas UI regions (keep in sync with index.html). */
export const RIGHT_COLUMN_WIDTH_PX = 340;
export const CHAT_HEIGHT_PX = 220;

export interface PopupGeometryOpts {
  /** Fraction of the canvas width the popup should take (0..1). Default 0.4. */
  widthFrac?: number;
  /** Absolute minimum width in px (floor). Default 320. */
  minWidthPx?: number;
  /** Safety margin on all sides inside the canvas. Default 40. */
  marginPx?: number;
}

/**
 * CSS fragment for positioning a popup centered inside the playable canvas
 * area with responsive width/height bounds. Combine with your existing
 * background/border/etc styles.
 */
export function popupGeometryCss(opts: PopupGeometryOpts = {}): string {
  const widthFrac = opts.widthFrac ?? 0.4;
  const minWidth = opts.minWidthPx ?? 320;
  const margin = opts.marginPx ?? 40;
  const right = RIGHT_COLUMN_WIDTH_PX;
  const bottom = CHAT_HEIGHT_PX;
  return `
    position: fixed;
    left: calc((100vw - ${right}px) / 2);
    top: calc((100vh - ${bottom}px) / 2);
    transform: translate(-50%, -50%);
    width: calc((100vw - ${right}px) * ${widthFrac});
    min-width: ${minWidth}px;
    max-width: calc(100vw - ${right}px - ${margin}px);
    max-height: calc(100vh - ${bottom}px - ${margin}px);
  `;
}

/**
 * Full popup container CSS — geometry + a flex-column layout so the inner
 * scroll area can `flex: 1 1 auto; min-height: 0` and overflow gracefully.
 */
export function popupContainerCss(opts: PopupGeometryOpts = {}): string {
  return `
    ${popupGeometryCss(opts)}
    display: none; flex-direction: column;
    z-index: 1001;
    font-family: monospace; color: #ddd; user-select: none;
    box-shadow: 0 4px 20px rgba(0,0,0,0.6);
  `;
}
