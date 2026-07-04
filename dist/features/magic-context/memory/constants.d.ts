import type { MemoryCategory } from "./types";
/**
 * The v2 world taxonomy — the only categories agents may WRITE today. Exposed
 * as the ctx_memory schema enum so invalid categories fail at validation
 * instead of bouncing off a runtime check. Legacy 9-cat values remain readable
 * (CATEGORY_PRIORITY) for pre-v2 rows but are not accepted for new writes.
 */
export declare const V2_MEMORY_CATEGORIES: readonly ["PROJECT_RULES", "ARCHITECTURE", "CONSTRAINTS", "CONFIG_VALUES", "NAMING"];
export declare const PROMOTABLE_CATEGORIES: MemoryCategory[];
export declare const CATEGORY_PRIORITY: MemoryCategory[];
export declare const MEMORY_CATEGORY_ORDER_UNKNOWN = 99;
export declare const MEMORY_CATEGORY_ORDER_PRIORITY: Record<MemoryCategory, number>;
export declare const MEMORY_CATEGORY_ORDER_SQL: string;
export declare function getMemoryCategoryOrder(category: string): number;
export declare const CATEGORY_DEFAULT_TTL: Partial<Record<MemoryCategory, number>>;
//# sourceMappingURL=constants.d.ts.map