/**
 * Get cached data if available and not expired.
 */
export declare function getCache<T>(keyParts: string[], ttlMs?: number): T | null;
/**
 * Save data to cache.
 */
export declare function setCache<T>(keyParts: string[], data: T, ttlMs?: number): void;
/**
 * Clear all cached data.
 */
export declare function clearCache(): {
    filesDeleted: number;
    bytesFreed: number;
};
/**
 * Get cache statistics.
 */
export declare function getCacheStats(): {
    files: number;
    totalBytes: number;
    oldestAge: number | null;
};
/**
 * Get cache directory path.
 */
export declare function getCacheDir(): string;
