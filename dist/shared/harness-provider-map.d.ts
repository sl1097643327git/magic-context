/**
 * Provider-id translation between the canonical (OpenCode) form stored in the
 * shared magic-context config and Pi's harness-native provider ids.
 *
 * OpenCode and Pi now share ONE config, but a few auth-plugin providers were
 * named differently on each side. The model id AFTER the slash is identical;
 * only the provider prefix differs:
 *
 *   canonical (OpenCode)   Pi
 *   --------------------   -------------------
 *   openai/<model>         openai-codex/<model>
 *   google/<model>         google-antigravity/<model>
 *   anthropic/<model>      anthropic/<model>      (same; every other provider too)
 *
 * Canonical = OpenCode: the config always stores the OpenCode form. Pi
 * translates at its edges:
 *   - read:  canonical -> Pi when spawning a configured model (subagent-runner).
 *   - write: Pi -> canonical in the Pi setup wizard, so a config written from
 *            the Pi side stays readable by OpenCode.
 *
 * OpenCode needs no translation (canonical IS the OpenCode form).
 */
/** Pi-native `provider/model` -> canonical (OpenCode). Identity when unmapped.
 *  Used by the Pi setup wizard so configs it writes stay OpenCode-readable. */
export declare function piModelRefToCanonical(ref: string): string;
/** Canonical (OpenCode) `provider/model` -> Pi-native, for spawning a model on
 *  Pi. Idempotent: normalizes any Pi-form prefix back to canonical first, so it
 *  is safe on a config that already holds Pi-form ids (hand-edited or pre-fix). */
export declare function resolveModelRefForPi(ref: string): string;
//# sourceMappingURL=harness-provider-map.d.ts.map