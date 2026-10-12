// The device shown for a photo or video: camera or phone tags, never a colour profile's maker.
import type { Tags } from 'exiftool-vendored'
import { describe, expect, it } from 'vitest'
import { deviceOf, makeOf } from '../src/main/media/exif'

const tags = (t: Record<string, unknown>): Tags => t as Tags

describe('device of a photo', () => {
  it('takes camera, phone and Sony video tags', () => {
    expect(deviceOf(tags({ Make: 'Apple', Model: 'iPhone 15' }))).toBe('iPhone 15')
    expect(deviceOf(tags({ AndroidManufacturer: 'Google', AndroidModel: 'Pixel 8' }))).toBe('Pixel 8')
    expect(deviceOf(tags({ DeviceManufacturer: 'Sony', DeviceModelName: 'ZV-E10' }))).toBe('ZV-E10')
    expect(makeOf(tags({ DeviceManufacturer: 'Sony', DeviceModelName: 'ZV-E10' }))).toBe('Sony')
  })

  it("ignores an embedded colour profile's manufacturer", () => {
    // exiftool reads the ICC profile header into DeviceManufacturer / DeviceModel
    expect(deviceOf(tags({ DeviceManufacturer: 'Unknown (saws)', DeviceModel: '' }))).toBeUndefined()
    expect(deviceOf(tags({ DeviceManufacturer: 'IEC', DeviceModel: 'sRGB' }))).toBeUndefined()
    expect(makeOf(tags({ DeviceManufacturer: 'IEC' }))).toBeUndefined()
    expect(deviceOf(tags({ Make: 'Canon', Model: 'EOS R6', DeviceManufacturer: 'IEC' }))).toBe('EOS R6')
  })
})
