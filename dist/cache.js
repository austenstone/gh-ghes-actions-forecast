"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCache = getCache;
exports.setCache = setCache;
exports.clearCache = clearCache;
exports.getCacheStats = getCacheStats;
exports.getCacheDir = getCacheDir;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const crypto = __importStar(require("crypto"));
const CACHE_DIR = path.join(os.homedir(), '.gh-forecast-cache');
const CACHE_VERSION = '1';
const DEFAULT_TTL_MS = 1000 * 60 * 60; // 1 hour
function ensureCacheDir() {
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
}
function getCacheKey(parts) {
    const hash = crypto.createHash('md5').update(parts.join('|')).digest('hex');
    return hash;
}
function getCachePath(key) {
    return path.join(CACHE_DIR, `${key}.json`);
}
/**
 * Get cached data if available and not expired.
 */
function getCache(keyParts, ttlMs = DEFAULT_TTL_MS) {
    try {
        ensureCacheDir();
        const key = getCacheKey(keyParts);
        const cachePath = getCachePath(key);
        if (!fs.existsSync(cachePath)) {
            return null;
        }
        const content = fs.readFileSync(cachePath, 'utf-8');
        const entry = JSON.parse(content);
        // Check version
        if (entry.version !== CACHE_VERSION) {
            fs.unlinkSync(cachePath);
            return null;
        }
        // Check TTL
        const age = Date.now() - entry.timestamp;
        if (age > ttlMs) {
            fs.unlinkSync(cachePath);
            return null;
        }
        return entry.data;
    }
    catch {
        return null;
    }
}
/**
 * Save data to cache.
 */
function setCache(keyParts, data, ttlMs = DEFAULT_TTL_MS) {
    try {
        ensureCacheDir();
        const key = getCacheKey(keyParts);
        const cachePath = getCachePath(key);
        const entry = {
            version: CACHE_VERSION,
            timestamp: Date.now(),
            ttlMs,
            data,
        };
        fs.writeFileSync(cachePath, JSON.stringify(entry), 'utf-8');
    }
    catch {
        // Silently fail - cache is optional
    }
}
/**
 * Clear all cached data.
 */
function clearCache() {
    let filesDeleted = 0;
    let bytesFreed = 0;
    try {
        if (!fs.existsSync(CACHE_DIR)) {
            return { filesDeleted: 0, bytesFreed: 0 };
        }
        const files = fs.readdirSync(CACHE_DIR);
        for (const file of files) {
            if (file.endsWith('.json')) {
                const filePath = path.join(CACHE_DIR, file);
                const stats = fs.statSync(filePath);
                bytesFreed += stats.size;
                fs.unlinkSync(filePath);
                filesDeleted++;
            }
        }
    }
    catch {
        // Ignore errors
    }
    return { filesDeleted, bytesFreed };
}
/**
 * Get cache statistics.
 */
function getCacheStats() {
    try {
        if (!fs.existsSync(CACHE_DIR)) {
            return { files: 0, totalBytes: 0, oldestAge: null };
        }
        const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json'));
        let totalBytes = 0;
        let oldestTimestamp = Date.now();
        for (const file of files) {
            const filePath = path.join(CACHE_DIR, file);
            const stats = fs.statSync(filePath);
            totalBytes += stats.size;
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const entry = JSON.parse(content);
                if (entry.timestamp < oldestTimestamp) {
                    oldestTimestamp = entry.timestamp;
                }
            }
            catch {
                // Ignore corrupt files
            }
        }
        return {
            files: files.length,
            totalBytes,
            oldestAge: files.length > 0 ? Date.now() - oldestTimestamp : null,
        };
    }
    catch {
        return { files: 0, totalBytes: 0, oldestAge: null };
    }
}
/**
 * Get cache directory path.
 */
function getCacheDir() {
    return CACHE_DIR;
}
//# sourceMappingURL=cache.js.map