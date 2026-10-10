// Messages between the editor and the vision worker (worker.ts).
import type { Pt } from '@shared/faceAlign'
import type { Rect } from '@shared/types'
import type { Delegate, Levels } from './detect'

export interface AnalyzeRequest {
  type: 'analyze'
  /** Full-size picture (transferred). */
  bitmap: ImageBitmap
  levels: Levels
  /** Also compute descriptors. */
  describe: boolean
  /** Faces already known (boxes): skip detection, only find their keypoints and descriptors. */
  known?: Rect[]
  /** With `known`: find each face again near its box, or in a wide area around it (following it through a clip). */
  locate?: 'near' | 'wide'
  /** Measurements: long edge of the copies handed to the detector (see detect.ts TILE_PX). */
  tilePx?: number
}

export interface InitRequest {
  type: 'init'
  /** Absolute URL of public/vision/ (with the trailing slash). */
  base: string
  /** Detector delegate to try first ('GPU' falls back to 'CPU'). */
  delegate: Delegate
}

export type VisionRequest = (AnalyzeRequest | InitRequest) & { id: number }

export interface AnalyzeResult {
  faces: Rect[]
  /** Keypoints per face (normalised), when found. */
  kp: (Pt[] | undefined)[]
  /** Detector confidence per face (1 for known boxes). */
  score?: number[]
  /** Size of the analysed picture in pixels. */
  size?: [number, number]
  desc?: number[][]
  /** Milliseconds spent detecting and describing. */
  ms: { detect: number; describe: number }
  delegate: Delegate
  /** TensorFlow.js backend of the descriptors ('webgl', 'cpu'), '' before the first use. */
  backend?: string
}

export interface InitResult {
  delegate: Delegate
}

export type VisionResponse = { id: number; ok: true; result: AnalyzeResult | InitResult } | { id: number; ok: false; error: string }
