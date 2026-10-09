// Priority limiter used to run thumbnails before display images before analysis.
import { describe, expect, it } from 'vitest'
import { createPriorityLimiter } from '../src/main/media/queue'

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

  it('a failing task frees its slot', async () => {
    const limit = createPriorityLimiter(1)
    await expect(limit(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(limit(async () => 'ok')).resolves.toBe('ok')
    await expect(limit.drained(0)).resolves.toBeUndefined()
  })
})
