// HDR proxies on the GPU (libplacebo): same picture as the CPU chain, CPU fallback on any failure.
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { detectGpuTonemap, pickVulkanDevice, type GpuTonemap } from '../src/main/media/hdr'
import { gpuEligible, gpuVideoFilter, TONEMAP_CHAIN, transcodeProxy } from '../src/main/media/video'
import { analyzeVideo, rotationOf, videoStream, type VideoInfo } from '../src/main/media/videoInfo'
import { ff } from './helpers/media'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-hdr-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

let gpu: GpuTonemap | null = null

const x265 = (trc: string): string[] => [
  '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1',
  '-x265-params', `log-level=error:colorprim=bt2020:transfer=${trc}:colormatrix=bt2020nc`,
  '-color_primaries', 'bt2020', '-color_trc', trc, '-colorspace', 'bt2020nc'
]

beforeAll(async () => {
  // HLG like an iPhone/Pixel clip: camera code values, stored landscape, shown portrait
  const hlg = join(tmp, 'hlg-stored.mov')
  await ff.run(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=3', ...x265('arib-std-b67'), hlg])
  await ff.run(['-display_rotation', '-90', '-i', hlg, '-c', 'copy', join(tmp, 'hlg.mov')])
  // PQ: an SDR picture graded to PQ with diffuse white at 203 nits (BT.2408), upside down
  const pq = join(tmp, 'pq-stored.mov')
  await ff.run(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=25:d=3', '-vf', 'hue=s=0.4,zscale=tin=bt709:min=bt709:pin=bt709:rin=tv:t=smpte2084:m=bt2020nc:p=bt2020:r=tv:npl=203,format=yuv420p10le', ...x265('smpte2084'), pq])
  await ff.run(['-display_rotation', '180', '-i', pq, '-c', 'copy', join(tmp, 'pq.mov')])
  gpu = await detectGpuTonemap(ff)
}, 180_000)

/** Frames at a few times as 96x54-ish RGB (area-averaged). */
async function frames(file: string, w: number, h: number): Promise<Buffer[]> {
  const out: Buffer[] = []
  for (const t of [0.2, 1.3, 2.5]) {
    out.push(await ff.capture(['-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=area,format=rgb24`, '-f', 'rawvideo', '-']))
  }
  return out
}

describe('GPU tone mapping', () => {
  it('picks the first discrete Vulkan device from the listing', () => {
    const log = [
      '[Vulkan @ 000001] GPU listing:',
      '[Vulkan @ 000001]     0: Intel(R) Iris(R) Xe Graphics (integrated) (0xa7a0)',
      '[Vulkan @ 000001]     1: NVIDIA GeForce RTX 4070 Laptop GPU (discrete) (0x2820)'
    ].join('\n')
    expect(pickVulkanDevice(log, 'discrete')).toBe(1)
    // DIASHOW_GPU=integrated: like a PC without the NVIDIA card
    expect(pickVulkanDevice(log, 'integrated')).toBe(0)
    expect(pickVulkanDevice('[Vulkan @ 1]     0: llvmpipe (LLVM 17.0.6, 256 bits) (cpu) (0x0)')).toBe(0)
    expect(pickVulkanDevice('no vulkan')).toBeNull()
  })

  it('builds one libplacebo pass with rotation and scaling, the tone curve on the GPU for PQ and on the CPU for HLG', () => {
    const info = { width: 1080, height: 1920, rotation: 90, hdr: 'hlg', interlaced: false } as VideoInfo
    const vf = gpuVideoFilter(info, 1920, { device: 1, decode: 'vulkan' }, { fps: 29.97 })
    expect(vf).toBe(`fps=30000/1001,libplacebo=w=1080:h=1920:rotate=90:apply_dolbyvision=0:range=tv:format=yuv420p10le,${TONEMAP_CHAIN},setsar=1`)
    expect(gpuVideoFilter({ ...info, hdr: 'pq' }, 960, { device: 0, decode: 'cuda' })).toMatch(/^hwupload,libplacebo=w=540:h=960:rotate=90:tonemapping=reinhard/)
    expect(gpuEligible({ ...info, interlaced: true })).toBe(false)
    expect(gpuEligible({ ...info, hdr: false })).toBe(false)
  })

  for (const name of ['hlg.mov', 'pq.mov']) {
    it(`${name}: GPU proxy matches the CPU chain (size, rotation, colours)`, async (ctx) => {
      if (!gpu) ctx.skip()
      const src = join(tmp, name)
      const info = analyzeVideo(await ff.probe(src))!
      expect(info.hdr).toBeTruthy()
      const encoders = await ff.encoders()
      const cpuOut = join(tmp, `cpu-${name}.mp4`)
      const gpuOut = join(tmp, `gpu-${name}.mp4`)
      expect((await transcodeProxy(ff, src, info, cpuOut, { encoders, gpu: null })).tonemap).toBe('cpu')
      const shaders = join(tmp, `shaders-${name}`)
      mkdirSync(shaders)
      expect((await transcodeProxy(ff, src, info, gpuOut, { encoders, gpu, shaderCache: shaders })).tonemap).toBe('gpu')
      // libplacebo kept its compiled shaders for the next transcode
      expect(readdirSync(shaders).some((f) => f.startsWith('pl'))).toBe(true)

      const probes = await Promise.all([ff.probe(cpuOut), ff.probe(gpuOut)])
      const [vc, vg] = probes.map((p) => videoStream(p)!)
      expect([vg.width, vg.height]).toEqual([vc.width, vc.height])
      expect([vg.codec_name, vg.profile, vg.pix_fmt, vg.color_transfer, vg.color_primaries]).toEqual(['h264', 'High', 'yuv420p', 'bt709', 'bt709'])
      expect(rotationOf(vg)).toBe(0)
      expect(vg.nb_frames).toBe(vc.nb_frames)

      const w = 48
      const h = Math.round((w * vc.height!) / vc.width! / 2) * 2
      const [a, b] = await Promise.all([frames(cpuOut, w, h), frames(gpuOut, w, h)])
      for (let f = 0; f < a.length; f++) {
        let mad = 0
        const bias = [0, 0, 0]
        for (let i = 0; i < a[f].length; i++) {
          mad += Math.abs(a[f][i] - b[f][i])
          bias[i % 3] += b[f][i] - a[f][i]
        }
        const n = a[f].length
        // a wrong orientation or a broken tone curve is off by 40+; HLG gets the CPU curve after the GPU
        // pass, PQ libplacebo's Reinhard, which differs by a few levels
        expect(mad / n, `${name} frame ${f} mean |diff|`).toBeLessThan(name === 'hlg.mov' ? 3 : 10)
        for (const c of bias) expect(Math.abs(c / (n / 3)), `${name} frame ${f} channel bias`).toBeLessThan(8)
      }
    })
  }

  it('SDR: one libplacebo pass for scaling and rotation without a tone curve, only for streams the GPU decodes', () => {
    const info = { width: 1080, height: 1920, rotation: 90, hdr: false, interlaced: false, chroma: '4:2:0', bitDepth: 8, stream: { index: 0, codec_name: 'h264' } } as VideoInfo
    const g: GpuTonemap = { device: 1, decode: 'vulkan' }
    expect(gpuVideoFilter(info, 1920, g, { fps: 30 })).toBe('fps=30,libplacebo=w=1080:h=1920:rotate=90:range=tv:format=yuv420p,setsar=1')
    expect(gpuEligible(info, g)).toBe(true)
    expect(gpuEligible(info)).toBe(false)
    expect(gpuEligible(info, { device: 0, decode: 'upload' })).toBe(false)
    expect(gpuEligible({ ...info, chroma: '4:2:2' }, g)).toBe(false)
    expect(gpuEligible({ ...info, bitDepth: 10 }, g)).toBe(false)
    expect(gpuEligible({ ...info, bitDepth: 10, stream: { index: 0, codec_name: 'hevc' } }, g)).toBe(true)
    expect(gpuEligible({ ...info, stream: { index: 0, codec_name: 'prores' } }, g)).toBe(false)
    expect(gpuEligible({ ...info, interlaced: true }, g)).toBe(false)
  })

  it('SDR on the GPU: rotated full-range H.264 gives the same proxy as the CPU chain', async (ctx) => {
    if (!gpu || gpu.decode === 'upload') ctx.skip()
    const stored = join(tmp, 'sdr-stored.mp4')
    await ff.run(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuvj420p', '-color_range', 'pc', stored])
    const src = join(tmp, 'sdr.mp4')
    await ff.run(['-display_rotation', '-90', '-i', stored, '-c', 'copy', src])
    const info = analyzeVideo(await ff.probe(src))!
    expect([info.rotation, info.hdr]).toEqual([90, false])
    expect(gpuEligible(info, gpu)).toBe(true)
    const encoders = await ff.encoders()
    const cpuOut = join(tmp, 'cpu-sdr.mp4')
    const gpuOut = join(tmp, 'gpu-sdr.mp4')
    await transcodeProxy(ff, src, info, cpuOut, { encoders, gpu: null })
    const shaders = join(tmp, 'shaders-sdr')
    mkdirSync(shaders)
    await transcodeProxy(ff, src, info, gpuOut, { encoders, gpu, shaderCache: shaders })
    // The GPU attempt ran (libplacebo stored its shaders) rather than the CPU fallback
    expect(readdirSync(shaders).some((f) => f.startsWith('pl'))).toBe(true)
    const [vc, vg] = (await Promise.all([ff.probe(cpuOut), ff.probe(gpuOut)])).map((p) => videoStream(p)!)
    expect([vg.width, vg.height, vg.pix_fmt, vg.color_range, vg.nb_frames]).toEqual([vc.width, vc.height, 'yuv420p', 'tv', vc.nb_frames])
    expect([vg.width, vg.height]).toEqual([720, 1280])
    expect(rotationOf(vg)).toBe(0)
    const [a, b] = await Promise.all([frames(cpuOut, 27, 48), frames(gpuOut, 27, 48)])
    for (let f = 0; f < a.length; f++) {
      let mad = 0
      for (let i = 0; i < a[f].length; i++) mad += Math.abs(a[f][i] - b[f][i])
      // wrong rotation or range would be off by 10+ levels
      expect(mad / a[f].length, `frame ${f}`).toBeLessThan(3)
    }
  })

  it('falls back to the CPU chain when the GPU path fails', async () => {
    const src = join(tmp, 'hlg.mov')
    const info = analyzeVideo(await ff.probe(src))!
    const out = join(tmp, 'fallback.mp4')
    const r = await transcodeProxy(ff, src, info, out, { gpu: { device: 97, decode: 'upload' } })
    expect(r).toEqual({ encoder: 'libx264', tonemap: 'cpu' })
    expect(videoStream(await ff.probe(out))!.color_transfer).toBe('bt709')
  })
})
