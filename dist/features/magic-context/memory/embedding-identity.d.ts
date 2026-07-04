import type { EmbeddingConfig } from "../../../config/schema/magic-context";
/**
 * Stable embedding-provider identity used for provider/pipeline reuse.
 *
 * The API key value is intentionally never hashed or stored. Only key
 * presence participates in identity so switching between anonymous and
 * authenticated modes recreates the provider, while rotating a key does not
 * leak secret material into logs or persisted model ids.
 */
export declare function getEmbeddingProviderIdentity(config: EmbeddingConfig): string;
//# sourceMappingURL=embedding-identity.d.ts.map