/**
 * The `StorageProvider` contract, as data — one suite for every implementation (#198).
 *
 * Design record §1.5 asks for the same assertions against `MemoryStorage`, the in-process fake, and
 * live R2 behind an opt-in. Copying the suite into a second file is how a live tier ends up checking
 * less than the fake it was cloned from, which inverts the purpose: the live run exists precisely to
 * catch behaviours a fake can be too generous about.
 *
 * @param label test-output name of the implementation
 * @param make  returns a provider, optionally with `close()` for a server or a bucket namespace to clean
 */
import { describe, it, expect } from 'vitest'
import type { StorageProvider } from '../../src/storage.js'

export type Make = () => Promise<{ provider: StorageProvider; close?: () => Promise<void> }>

export function contractSuite(label: string, make: Make): void {
  describe(`StorageProvider contract — ${label}`, () => {
    it('round-trips a value and returns undefined for a key never written', async () => {
      const { provider, close } = await make()
      try {
        await provider.put('knowledge/a/manifest.json', '{"id":"a"}')
        expect(await provider.get('knowledge/a/manifest.json')).toBe('{"id":"a"}')
        expect(await provider.get('knowledge/missing.json')).toBeUndefined()
      } finally { await close?.() }
    })

    it('put is last-write-wins, not append', async () => {
      const { provider, close } = await make()
      try {
        await provider.put('sessions/_index.json', 'first')
        await provider.put('sessions/_index.json', 'second')
        expect(await provider.get('sessions/_index.json')).toBe('second')
      } finally { await close?.() }
    })

    it('preserves text exactly, including non-ASCII', async () => {
      const { provider, close } = await make()
      try {
        const text = '# heading\n\nünïcödé ✅ → done\n'
        await provider.put('knowledge/x/processed.md', text)
        expect(await provider.get('knowledge/x/processed.md')).toBe(text)
      } finally { await close?.() }
    })

    it('accepts bytes', async () => {
      const { provider, close } = await make()
      try {
        await provider.put('knowledge/bin/source.pdf', new Uint8Array([0, 1, 2, 250, 251, 252]))
        expect(typeof await provider.get('knowledge/bin/source.pdf')).toBe('string')
      } finally { await close?.() }
    })

    it('lists a prefix lexicographically and excludes other prefixes', async () => {
      const { provider, close } = await make()
      try {
        for (const k of ['feedback/c.json', 'feedback/a.json', 'feedback/b.json', 'sessions/a/manifest.json']) {
          await provider.put(k, k)
        }
        expect(await provider.list('feedback/')).toEqual(['feedback/a.json', 'feedback/b.json', 'feedback/c.json'])
        expect(await provider.list('knowledge/')).toEqual([])
      } finally { await close?.() }
    })

    it('treats a prefix as a string boundary, not a directory', async () => {
      const { provider, close } = await make()
      try {
        await provider.put('feedback/1.json', 'x')
        await provider.put('feedback/1.json.bak', 'y')
        expect(await provider.list('feedback/1')).toEqual(['feedback/1.json', 'feedback/1.json.bak'])
      } finally { await close?.() }
    })

    it('delete reports whether the key existed', async () => {
      const { provider, close } = await make()
      try {
        await provider.put('jobs/train-x.json', '{}')
        expect(await provider.delete('jobs/train-x.json')).toBe(true)
        expect(await provider.delete('jobs/train-x.json')).toBe(false)
        expect(await provider.get('jobs/train-x.json')).toBeUndefined()
      } finally { await close?.() }
    })
  })
}
