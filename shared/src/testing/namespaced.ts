/**
 * A prefix-scoped view over a `StorageProvider` (#198).
 *
 * The live R2 tier has to run the full contract suite — reads, deletes, prefix listings — without
 * touching anything else in the bucket, because the same bucket may hold a real corpus. Doing that by
 * wrapping only `put()` is broken in a way that a skipped test never reveals: writes land under the
 * namespace while every read, delete and listing addresses the un-prefixed key, so the suite can only
 * ever fail. That is what this file replaces.
 *
 * Translation goes both ways: keys are namespaced on the way in and stripped on the way out, so a
 * caller sees a private bucket whose root is its own prefix.
 */
import type { StorageProvider } from '../storage.js'

export class NamespacedStorage implements StorageProvider {
  /** Always ends with `/`, so a prefix boundary is a real directory edge, not a string accident. */
  private readonly root: string

  constructor(private readonly inner: StorageProvider, prefix: string) {
    this.root = prefix.endsWith('/') ? prefix : `${prefix}/`
  }

  private in(key: string): string { return `${this.root}${key}` }
  private out(key: string): string { return key.startsWith(this.root) ? key.slice(this.root.length) : key }

  async put(key: string, body: string | Uint8Array): Promise<void> {
    await this.inner.put(this.in(key), body)
  }

  async get(key: string): Promise<string | undefined> {
    return await this.inner.get(this.in(key))
  }

  async list(prefix = ''): Promise<string[]> {
    const keys = await this.inner.list(this.in(prefix))
    return keys.map((k) => this.out(k)).sort()
  }

  async delete(key: string): Promise<boolean> {
    return await this.inner.delete(this.in(key))
  }

  /** Everything this namespace created, for teardown that cannot miss an object. */
  async clear(): Promise<number> {
    const keys = await this.inner.list(this.root)
    for (const key of keys) await this.inner.delete(key)
    return keys.length
  }
}
