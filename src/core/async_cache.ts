/**
* GRIP Async Cache - Caching utilities for asynchronous operations
* 
* Provides caching interfaces and implementations for storing and retrieving
* results from asynchronous operations. Used primarily by async Taps to
* improve performance and reduce redundant requests.
* 
* Key Features:
* - LRU (Least Recently Used) eviction policy
* - TTL (Time To Live) expiration support
* - Configurable cache size limits
* - Automatic cleanup of expired entries
* - Thread-safe operations
* 
* Use Cases:
* - Async Tap result caching
* - Request deduplication
* - Performance optimization
* - Memory management for large datasets
*/

/**
* Represents a cached entry with value and expiration information.
* 
* @template T - The type of the cached value
* @property value - The cached value
* @property expiresAt - Timestamp when the entry expires (0 = no expiration)
*/
export interface CacheEntry<T> {
value: T;
expiresAt: number;
}

/**
* Interface for asynchronous caching operations.
* 
* Provides a standard interface for cache implementations, enabling
* different caching strategies while maintaining a consistent API.
* 
* @template K - The key type
* @template V - The value type
*/
export interface AsyncCache<K, V> {
/**
* Retrieves a value from the cache.
* 
* @param key - The cache key
* @returns The cached entry or undefined if not found/expired
*/
get(key: K): CacheEntry<V> | undefined;

/**
* Stores a value in the cache with expiration.
* 
* @param key - The cache key
* @param value - The value to cache
* @param ttlMs - Time to live in milliseconds (0 = no expiration)
*/
set(key: K, value: V, ttlMs: number): void;

/**
* Removes a value from the cache.
* 
* @param key - The cache key to remove
*/
delete(key: K): void;

/**
* Gets the current number of entries in the cache.
* 
* @returns The number of cached entries
*/
size(): number;
}

/**
* Simple LRU + TTL cache suitable for async Tap memoization.
* 
* Implements a cache with both LRU (Least Recently Used) eviction and
* TTL (Time To Live) expiration. This combination provides efficient
* memory management while ensuring data freshness.
* 
* Key Features:
* - LRU eviction when cache reaches capacity
* - TTL-based expiration for automatic cleanup
* - Configurable maximum size
* - Automatic refresh of LRU order on access
* 
* @template K - The key type
* @template V - The value type
*/
export class LruTtlCache<K, V> implements AsyncCache<K, V> {
private readonly maxEntries: number;
private readonly map = new Map<K, CacheEntry<V>>();

/**
* Creates a new LRU-TTL cache with the specified maximum size.
* 
* @param maxEntries - Maximum number of entries (default: 200, minimum: 1)
*/
constructor(maxEntries = 200) {
this.maxEntries = Math.max(1, maxEntries);
}

/**
* Retrieves a value from the cache.
* 
* Checks for expiration and automatically removes expired entries.
* Refreshes the LRU order by moving the accessed entry to the end.
* 
* @param key - The cache key
* @returns The cached entry or undefined if not found/expired
*/
get(key: K): CacheEntry<V> | undefined {
const entry = this.map.get(key);
if (!entry) return undefined;

// Check for expiration
if (entry.expiresAt > 0 && entry.expiresAt < Date.now()) {
this.map.delete(key);
return undefined;
}

// Refresh LRU order by moving to end
this.map.delete(key);
this.map.set(key, entry);
return entry;
}

/**
* Stores a value in the cache with expiration.
* 
* If the key already exists, it's replaced. The entry is added to the end
* of the LRU order, and eviction is triggered if the cache exceeds capacity.
* 
* @param key - The cache key
* @param value - The value to cache
* @param ttlMs - Time to live in milliseconds (0 = no expiration)
*/
set(key: K, value: V, ttlMs: number): void {
const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : 0;

// Remove existing entry to update LRU order
if (this.map.has(key)) this.map.delete(key);

// Add new entry at the end (most recently used)
this.map.set(key, { value, expiresAt });

// Evict oldest entries if over capacity
this.evictIfNeeded();
}

/**
* Removes a value from the cache.
* 
* @param key - The cache key to remove
*/
delete(key: K): void {
this.map.delete(key);
}

/**
* Gets the current number of entries in the cache.
* 
* @returns The number of cached entries
*/
size(): number {
return this.map.size;
}

/**
* Evicts the oldest entries if the cache exceeds capacity.
* 
* Removes entries from the beginning of the map (oldest) until
* the cache size is within the maximum limit.
*/
private evictIfNeeded(): void {
if (this.map.size <= this.maxEntries) return;

// Evict oldest entries until under capacity
const overflow = this.map.size - this.maxEntries;
for (let i = 0; i < overflow; i++) {
const firstKey = this.map.keys().next().value as K | undefined;
if (firstKey === undefined) break;
this.map.delete(firstKey);
}
}
}
