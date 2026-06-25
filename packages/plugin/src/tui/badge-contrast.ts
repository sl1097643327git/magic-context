/**
 * Pick a readable text color (black or white) for text drawn ON TOP of a given
 * background color.
 *
 * The sidebar header badge previously drew its label with `fg={theme.background}`
 * on a `theme.accent` background. That breaks for themes that set
 * `background: "none"` (transparent) to respect terminal transparency: the
 * resolved background is `RGBA(0,0,0,0)`, so the badge text renders fully
 * transparent and disappears (issue #186). The badge background (`accent`) is
 * always opaque, so deriving the text color from it is transparency-proof.
 *
 * `RGBA` channels from @opentui/core are normalized 0..1 floats. We accept the
 * minimal `{ r, g, b }` shape so this stays a pure, trivially testable function
 * independent of the native color class.
 */
export function readableTextColorOn(bg: { r: number; g: number; b: number }): string {
    // Perceptual brightness (ITU-R BT.601 luma weights). Channels are 0..1, so
    // the result is 0..1; >= 0.5 is a "light" background that needs dark text.
    const brightness = 0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b;
    return brightness >= 0.5 ? "#000000" : "#ffffff";
}
