import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/index.js'
import { MemoryStorage } from '../src/lib/backends.js'
import type { SaipRuntimeConfig } from '../src/lib/config.js'

const repoConfig = fileURLToPath(new URL('../../saip.yaml', import.meta.url))

describe('createApp wiring', () => {
  it('boots with injected config + storage and exposes gateway state', async () => {
    const storage = new MemoryStorage()
    const ctx = (await createApp({ storage, configPath: repoConfig })) as any
    expect(ctx.adapterRegistry).toBeDefined()
    expect(typeof ctx.gatewayState?.storage?.put).toBe('function')
    expect(ctx.gatewayState.config.adapters.length).toBe(3)
    // same storage instance is shared across plugins
    await ctx.gatewayState.storage.put('x', 'y')
    expect(await storage.get('x')).toBe('y')
  })

  it('reads config through loadConfig() when nothing is injected, and refuses storage silently (#198)', async () => {
    const prev = process.env.SAIP_CONFIG
    process.env.SAIP_CONFIG = repoConfig
    try {
      // The committed `saip.yaml` interpolates `${SAIP_R2_BUCKET:-}`, so this checkout has an
      // empty bucket and env-isolation guarantees no shell value leaks in. That is precisely the
      // configuration that used to boot a gateway onto a Map. It must now refuse, naming the
      // variable, instead of reporting success for writes that die at restart.
      await expect(createApp()).rejects.toThrow(/SAIP_R2_BUCKET/)
    } finally {
      if (prev === undefined) delete process.env.SAIP_CONFIG
      else process.env.SAIP_CONFIG = prev
    }
  })

  it('boots with config read from disk once memory is opted into by name (#198)', async () => {
    const saved = { ...process.env }
    process.env.SAIP_CONFIG = repoConfig
    process.env.SAIP_STORAGE = 'memory'
    const lines: string[] = []
    const realWrite = process.stderr.write.bind(process.stderr)
    ;(process as any).stderr.write = (c: any) => { lines.push(String(c)); return true }
    try {
      const ctx = (await createApp()) as any
      expect(ctx.gatewayState.config.model.base).toBe('QuantTrio/Qwen3.5-4B-AWQ')
      expect(typeof ctx.gatewayState.storage.list).toBe('function')
      // Opt-in is only honest if it is loud: the line must actually have been printed.
      expect(lines.join('')).toContain('EXPLICIT MEMORY')
      expect(lines.join('')).toContain('dies at restart')
    } finally {
      ;(process as any).stderr.write = realWrite
      for (const k of ['SAIP_CONFIG', 'SAIP_STORAGE']) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!
      }
    }
  })

  it('throws on an invalid adapter registry at boot', async () => {
    const bad: SaipRuntimeConfig = {
      model: { base: '' },
      users: [],
      adapters: [
        { name: 'a', scope: 'user', trainable: false, composite: { gain: 1, merge: 'weighted_linear', components: [{ adapter: 'a', weight: 1 }, { adapter: 'b', weight: 1 }] } } as any,
        { name: 'b', scope: 'global', trainable: true, training: { strategy: 's', data_scopes: ['documents'] } } as any,
      ],
      inference: { port: 8000, maxLoras: 4, systemone: { enabled: false } },
    }
    await expect(createApp({ config: bad, storage: new MemoryStorage() })).rejects.toThrow(/adapter registry/i)
  })
})
