import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const CACHE_DIR = path.join(os.homedir(), '.gh-forecast-cache');
const CACHE_VERSION = '1';
const DEFAULT_TTL_MS = 1000 * 60 * 60; // 1 hour

interface CacheEntry<T> {
  version: string;
  timestamp: number;
  ttlMs: number;
  data: T;
}

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function getCacheKey(parts: string[]): string {
  const hash = crypto.createHash('md5').update(parts.join('|')).digest('hex');
  return hash;
}

function getCachePath(key: string): string {
  return path.join(CACHE_DIR, `${key}.json`);
}

/**
 * Get cached data if available and not expired.
 */
export function getCache<T>(keyParts: string[], ttlMs: number = DEFAULT_TTL_MS): T | null {
  try {
    ensureCacheDir();
    const key = getCacheKey(keyParts);
    const cachePath = getCachePath(key);
    
    if (!fs.existsSync(cachePath)) {
      return null;
    }
    
    const content = fs.readFileSync(cachePath, 'utf-8');
    const entry: CacheEntry<T> = JSON.parse(content);
    
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
  } catch {
    return null;
  }
}

/**
 * Save data to cache.
 */
export function setCache<T>(keyParts: string[], data: T, ttlMs: number = DEFAULT_TTL_MS): void {
  try {
    ensureCacheDir();
    const key = getCacheKey(keyParts);
    const cachePath = getCachePath(key);
    
    const entry: CacheEntry<T> = {
      version: CACHE_VERSION,
      timestamp: Date.now(),
      ttlMs,
      data,
    };
    
    fs.writeFileSync(cachePath, JSON.stringify(entry), 'utf-8');
  } catch {
    // Silently fail - cache is optional
  }
}

/**
 * Clear all cached data.
 */
export function clearCache(): { filesDeleted: number; bytesFreed: number } {
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
  } catch {
    // Ignore errors
  }
  
  return { filesDeleted, bytesFreed };
}

/**
 * Get cache statistics.
 */
export function getCacheStats(): { files: number; totalBytes: number; oldestAge: number | null } {
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
      } catch {
        // Ignore corrupt files
      }
    }
    
    return {
      files: files.length,
      totalBytes,
      oldestAge: files.length > 0 ? Date.now() - oldestTimestamp : null,
    };
  } catch {
    return { files: 0, totalBytes: 0, oldestAge: null };
  }
}

/**
 * Get cache directory path.
 */
export function getCacheDir(): string {
  return CACHE_DIR;
}
