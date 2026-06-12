// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightThemeObsidian from "starlight-theme-obsidian";

// https://astro.build/config
export default defineConfig({
    site: "https://docs.cortexkit.io",
    base: "/magic-context",
    // Nest output under /magic-context so the deployed asset tree matches the
    // URL space — sibling CortexKit plugin docs will share this subdomain.
    outDir: "./dist-root/magic-context",
    integrations: [
        starlight({
            plugins: [starlightThemeObsidian({ graph: false, backlinks: false })],
            title: "Magic Context",
            description:
                "Persistent memory and self-managing context for OpenCode and Pi coding agents.",
            social: [
                {
                    icon: "github",
                    label: "GitHub",
                    href: "https://github.com/cortexkit/magic-context",
                },
                { icon: "discord", label: "Discord", href: "https://discord.gg/mvegWMTr" },
            ],
            editLink: {
                baseUrl: "https://github.com/cortexkit/magic-context/edit/master/packages/docs/",
            },
            sidebar: [
                {
                    label: "Getting Started",
                    items: [
                        { slug: "getting-started/introduction" },
                        { slug: "getting-started/installation" },
                        { slug: "getting-started/first-session" },
                        { slug: "getting-started/migrating-between-harnesses" },
                    ],
                },
                {
                    label: "Concepts",
                    items: [
                        { slug: "concepts/overview" },
                        { slug: "concepts/historian" },
                        { slug: "concepts/memory" },
                        { slug: "concepts/dreamer" },
                        { slug: "concepts/context-reduction" },
                        { slug: "concepts/cache-architecture" },
                        { slug: "concepts/session-modes" },
                    ],
                },
                {
                    label: "Reference",
                    items: [
                        { slug: "reference/tools" },
                        { slug: "reference/commands" },
                        { slug: "reference/configuration" },
                        { slug: "reference/dashboard" },
                    ],
                },
                {
                    label: "Help",
                    items: [
                        { slug: "help/troubleshooting" },
                        { slug: "help/compatibility" },
                        { slug: "help/faq" },
                    ],
                },
            ],
        }),
    ],
});
