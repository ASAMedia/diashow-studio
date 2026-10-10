// Priority limiter used to run thumbnails before display images before analysis.
import { describe, expect, it } from 'vitest'
import { createGate, createPriorityLimiter, MediaOrder } from '../src/main/media/queue'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

describe('createPriorityLimiter', () => {
  it('starts queued tasks by priority, FIFO within a priority, never above the concurrency', async () => {
    const limit = createPriorityLimiter(2)
    const order: string[] = []
    let running = 0
    let peak = 0
    const task = (name: string) => async (): Promise<string> => {
      running++
      peak = Math.max(peak, running)
      order.push(name)
      await tick()
      running--
      return name
    }
    const results = await Promise.all([
      limit(task('d1'), 1),
      limit(task('d2'), 1),
      limit(task('a1'), 2),
      limit(task('t1'), 0),
      limit(task('d3'), 1),
      limit(task('t2'), 0)
    ])
    expect(results).toEqual(['d1', 'd2', 'a1', 't1', 'd3', 't2'])
    // d1, d2 start immediately; then the waiting thumbnails, the display, the analysis
    expect(order).toEqual(['d1', 'd2', 't1', 't2', 'd3', 'a1'])
    expect(peak).toBe(2)
  })

  it('drained(p) waits for all tasks up to priority p, in registration order', async () => {
    const limit = createPriorityLimiter(1)
    const log: string[] = []
    const thumbs = [limit(async () => { await tick(); log.push('thumb') }, 0), limit(async () => { await tick(); log.push('display') }, 1)]
    const analysis = limit(async () => { await tick(); log.push('analysis') }, 2)
    const first = limit.drained(1).then(() => log.push('video 1'))
    const second = limit.drained(1).then(() => log.push('video 2'))
    await Promise.all([...thumbs, analysis, first, second])
    expect(log.indexOf('video 1')).toBeGreaterThan(log.indexOf('display'))
    expect(log.indexOf('video 1')).toBe(log.indexOf('video 2') - 1)
    // Nothing queued: resolves right away
    await expect(limit.drained(5)).resolves.toBeUndefined()
  })

  it('within a class, tasks start in show order (MediaOrder), not in the order they were queued', async () => {
    const order = new MediaOrder()
    order.add(['a', 'b', 'c', 'd'])
    const limit = createPriorityLimiter(1, order)
    const started: string[] = []
    const task = (name: string) => async (): Promise<void> => {
      started.push(name)
      await tick()
    }
    await Promise.all([
      limit(task('busy'), 0, 'x'),
      limit(task('display d'), 1, 'd'),
      limit(task('thumb c'), 0, 'c'),
      limit(task('display a'), 1, 'a'),
      limit(task('thumb b'), 0, 'b'),
      limit(task('no id'), 0)
    ])
    // 'x' has no rank: it ran first only because the slot was free
    expect(started).toEqual(['busy', 'thumb b', 'thumb c', 'no id', 'display a', 'display d'])
  })

  it('prioritize(): focused items first, in the given order and with all their work; newest call wins', async () => {
    const order = new MediaOrder()
    order.add(['a', 'b', 'c', 'd', 'e'])
    const limit = createPriorityLimiter(1, order)
    const started: string[] = []
    let release!: () => void
    const blocker = limit(() => new Promise<void>((r) => (release = r)), 0, 'a')
    const queued = [
      limit(async () => void started.push('thumb b'), 0, 'b'),
      limit(async () => void started.push('analysis e'), 2, 'e'),
      limit(async () => void started.push('display d'), 1, 'd'),
      limit(async () => void started.push('thumb c'), 0, 'c')
    ]
    order.prioritize(['c', 'e'])
    order.prioritize(['e', 'd']) // replaces the call before
    release()
    await Promise.all([blocker, ...queued])
    expect(started).toEqual(['analysis e', 'display d', 'thumb b', 'thumb c'])
    // [] goes back to show order
    order.prioritize([])
    expect(order.key(0, 'e')).toEqual([1, 0, 4])
  })

  it('drained(p, id) and gates let a focused item through at once, others wait for the work', async () => {
    const order = new MediaOrder()
    const limit = createPriorityLimiter(1, order)
    let release!: () => void
    const running = limit(() => new Promise<void>((r) => (release = r)), 0, 'busy')
    const log: string[] = []
    const plain = limit.drained(0, 'x').then(() => log.push('x'))
    const focused = limit.drained(0, 'y').then(() => log.push('y'))
    const gate = createGate(order)
    gate.enter()
    gate.enter()
    const viaGate = gate.wait('z').then(() => log.push('gate z'))
    const viaGateLater = gate.wait('w').then(() => log.push('gate w'))
    await tick()
    expect(log).toEqual([])
    order.prioritize(['y', 'z'])
    await tick()
    expect(log).toEqual(['y', 'gate z'])
    gate.leave()
    await tick()
    expect(log).toEqual(['y', 'gate z'])
    gate.leave()
    await tick()
    expect(log).toEqual(['y', 'gate z', 'gate w'])
    expect(gate.count).toBe(0)
    release()
    await Promise.all([running, plain, focused, viaGate, viaGateLater])
    expect(log).toEqual(['y', 'gate z', 'gate w', 'x'])
    await expect(gate.wait()).resolves.toBeUndefined()
  })

  it('a failing task frees its slot', async () => {
    const limit = createPriorityLimiter(1)
    await expect(limit(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(limit(async () => 'ok')).resolves.toBe('ok')
    await expect(limit.drained(0)).resolves.toBeUndefined()
  })
})
