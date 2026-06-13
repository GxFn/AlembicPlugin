export interface ContextCacheEntry<T> {
  createdAt: string;
  derivedView: true;
  key: string;
  value: T;
}

export class ContextCache<T> {
  private readonly entries = new Map<string, ContextCacheEntry<T>>();

  get(key: string): ContextCacheEntry<T> | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: T, now: string = new Date().toISOString()): ContextCacheEntry<T> {
    const entry: ContextCacheEntry<T> = {
      createdAt: now,
      derivedView: true,
      key,
      value,
    };
    this.entries.set(key, entry);
    return entry;
  }

  clear(): void {
    this.entries.clear();
  }
}
