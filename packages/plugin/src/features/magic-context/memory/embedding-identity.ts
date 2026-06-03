import type { EmbeddingConfig } from "../../../config/schema/magic-context";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../../../config/schema/magic-context";
import { computeNormalizedHash } from "./normalize-hash";

function normalizeEndpoint(endpoint?: string): string {
    return endpoint?.trim().replace(/\/+$/, "") ?? "";
}

/**
 * Stable embedding-provider identity used for provider/pipeline reuse.
 *
 * The API key value is intentionally never hashed or stored. Only key
 * presence participates in identity so switching between anonymous and
 * authenticated modes recreates the provider, while rotating a key does not
 * leak secret material into logs or persisted model ids.
 */
export function getEmbeddingProviderIdentity(config: EmbeddingConfig): string {
    if (config.provider === "off") {
        return "embedding-provider:off";
    }

    const identityInput =
        config.provider === "openai-compatible"
            ? {
                  provider: "openai-compatible",
                  model: config.model.trim(),
                  endpoint: normalizeEndpoint(config.endpoint),
                  apiKeyPresent: Boolean(config.api_key?.trim()),
                  // input_type changes the embedding vector space (e.g. NIM
                  // 'query' vs 'passage'), so it participates in identity — a
                  // change must re-embed. truncate only affects over-long inputs
                  // and does not change the space, so it is intentionally omitted.
                  inputType: config.input_type?.trim() || "",
              }
            : {
                  provider: "local",
                  model: config.model?.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL,
                  endpoint: "",
                  apiKeyPresent: false,
              };

    return `embedding-provider:${computeNormalizedHash(JSON.stringify(identityInput))}`;
}
