// The filmstrip's menus (Filmstrip.tsx): the "+" card's (add photos, a folder or a text slide) and a
// slide's (right click, the menu key or Shift+F10): insert, combine, split, group again, leave out,
// edit, delete.
import { Crop as CropIcon, EyeOff, FolderPlus, ImagePlus, LayoutGrid, Merge, Move, RotateCcw, Split, Trash2, Type } from 'lucide-react'
import { themeMeta } from '@shared/themes'
import type { Timeline, TimelineSlide } from '@shared/timeline'
import type { Project } from '@shared/types'
import { useStore } from '../store'
import { t } from '../i18n'
import { insertFiles, placeAt } from '../insert'
import { isFixed } from '../entryEdits'
import { openPhotoEdit, rotateSelection } from '../photoEdit'
import { Menu, MenuItem, MenuSeparator } from './Menu'

/** Where a menu of the filmstrip opens, and for what: a slide, or (`add`) the "+" card. */
export interface StripMenuAt {
  x: number
  y: number
  slide?: TimelineSlide
  add?: boolean
}

/** `selectedSlides`: the slides with selected entries. */
export function StripMenu({ menu, tl, project, selectedSlides, onClose }: { menu: StripMenuAt; tl: Timeline; project: Project; selectedSlides: TimelineSlide[]; onClose: () => void }) {
  const select = useStore((s) => s.select)
  const maxPer = themeMeta(project.settings.theme).maxPerSlide
  // a title slide has no menu
  if (!(menu.add || (menu.slide && menu.slide.kind !== 'title'))) return null
  return (
    <Menu label={menu.add ? t('addToShow') : t('slideMenu')} onClose={onClose} style={{ left: menu.x, top: Math.max(8, menu.y - (menu.add ? 0 : 10)) }}>
      {menu.add && (
        <>
          <MenuItem icon={<ImagePlus size={15} />} onSelect={async () => useStore.getState().importMedia(await window.api.pickMedia())}>
            {t('addMedia')}
          </MenuItem>
          <MenuItem icon={<FolderPlus size={15} />} onSelect={async () => useStore.getState().importMedia(await window.api.pickFolder())}>
            {t('addFolder')}
          </MenuItem>
          <MenuItem icon={<Type size={15} />} onSelect={() => useStore.getState().addText()}>
            {t('addText')}
          </MenuItem>
        </>
      )}
      {menu.slide && menu.slide.kind !== 'title' && (
        <>
          <MenuItem
            icon={<ImagePlus size={15} />}
            onSelect={async () => {
              // behind this slide, wherever it is by the time the dialog closes
              const place = placeAt(menu.slide!.index + 1)
              const paths = await window.api.pickMedia()
              if (paths.length) await insertFiles(paths, place)
            }}
          >
            {t('insertHere')}
          </MenuItem>
          <MenuItem icon={<Type size={15} />} onSelect={() => useStore.getState().addText()}>
            {t('addText')}
          </MenuItem>
          {/* a panorama and a Live Photo that plays keep their slide to themselves */}
          {selectedSlides.length > 1 && maxPer > 1 && !selectedSlides.some((x) => x.pano || x.live) && selectedSlides.reduce((k, x) => k + x.entries.length, 0) <= maxPer && (
            <MenuItem icon={<Merge size={15} />} onSelect={() => useStore.getState().mergeEntries(selectedSlides.flatMap((x) => x.entries.map((e) => e.id)))}>
              {t('merge')}
            </MenuItem>
          )}
          {menu.slide.entries.length > 1 && (
            <MenuItem icon={<Split size={15} />} onSelect={() => useStore.getState().splitSlide(menu.slide!.entries.map((e) => e.id))}>
              {t('split')}
            </MenuItem>
          )}
          {menu.slide.kind !== 'text' && !menu.slide.pano && !menu.slide.live && maxPer > 1 && menu.slide.index > 0 && ['photos', 'video'].includes(tl.slides[menu.slide.index - 1]?.kind) && !tl.slides[menu.slide.index - 1]?.pano && !tl.slides[menu.slide.index - 1]?.live && (
            <MenuItem
              icon={<Merge size={15} />}
              onSelect={() => {
                const prev = tl.slides[menu.slide!.index - 1]
                useStore.getState().mergeEntries([...prev.entries, ...menu.slide!.entries].map((e) => e.id))
              }}
            >
              {t('joinPrev')}
            </MenuItem>
          )}
          {maxPer > 1 &&
            (() => {
              // the selected slides, or the one clicked when it isn't among them
              const targets = selectedSlides.some((x) => x.index === menu.slide!.index) ? selectedSlides : [menu.slide!]
              const ids = new Set(targets.flatMap((x) => x.entries.map((e) => e.id)))
              if (!project.entries.some((e) => ids.has(e.id) && isFixed(e))) return null
              return (
                <MenuItem icon={<LayoutGrid size={15} />} onSelect={() => useStore.getState().autoGroup([...ids])}>
                  {t('autoGroup')}
                </MenuItem>
              )
            })()}
          <MenuItem
            icon={<EyeOff size={15} />}
            onSelect={() => {
              const ids = (selectedSlides.length ? selectedSlides : [menu.slide!]).flatMap((x) => x.entries.map((y) => y.id))
              useStore.getState().updateEntries(ids, (x) => (x.excluded = true))
              select([])
            }}
          >
            {t('excludeSel')}
          </MenuItem>
          {(menu.slide.kind === 'photos' || menu.slide.kind === 'video') && (
            <>
              <MenuItem icon={<CropIcon size={15} />} onSelect={() => openPhotoEdit(menu.slide!.entries[0].id)}>
                {t('peEdit')}
              </MenuItem>
              <MenuItem icon={<RotateCcw size={15} />} onSelect={() => rotateSelection(-1)}>
                {`${t('peRotateLeft')} (${t('kbdRotate')})`}
              </MenuItem>
            </>
          )}
          {menu.slide.kind === 'photos' && themeMeta(project.settings.theme).kenBurns && (
            <MenuItem icon={<Move size={15} />} onSelect={() => useStore.getState().set({ tab: 'slide', kbEdit: 'start' })}>
              {t('kbEdit')}
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem icon={<Trash2 size={15} />} onSelect={() => useStore.getState().removeEntries(menu.slide!.entries.map((e) => e.id))}>
            {t('deleteSlide')}
          </MenuItem>
        </>
      )}
    </Menu>
  )
}
