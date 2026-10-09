// Projects are stored as `<id>.dshow` JSON files in Documents\Diashow Studio (directory injected).
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Project, ProjectSummary } from '@shared/types'

export const PROJECT_EXT = '.dshow'

export interface ProjectStore {
  readonly dir: string
  list(): Promise<ProjectSummary[]>
  load(id: string): Promise<Project>
  save(project: Project): Promise<void>
  delete(id: string): Promise<void>
}

/** Ids become file names; only allow safe characters so an id can never escape the folder. */
function checkId(id: string): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error(`invalid project id: ${String(id)}`)
  return id
}

export function summarize(project: Project): ProjectSummary {
  const media = new Map(project.media.map((m) => [m.id, m]))
  const firstPhoto = project.entries.find((e) => e.type === 'photo')
  const cover = firstPhoto && firstPhoto.type === 'photo' ? media.get(firstPhoto.mediaId)?.thumb : undefined
  const summary: ProjectSummary = {
    id: project.id,
    name: project.name,
    updatedAt: project.updatedAt,
    slideCount: project.entries.length
  }
  if (cover) summary.cover = cover
  return summary
}

export function createProjectStore(dir: string): ProjectStore {
  const file = (id: string): string => join(dir, `${checkId(id)}${PROJECT_EXT}`)

  return {
    dir,

    async list() {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        return []
      }
      const summaries = await Promise.all(
        names
          .filter((n) => n.toLowerCase().endsWith(PROJECT_EXT))
          .map(async (n) => {
            try {
              const p = JSON.parse(await readFile(join(dir, n), 'utf8')) as Project
              if (!p || typeof p.id !== 'string' || !Array.isArray(p.entries)) return null
              return summarize({ ...p, media: Array.isArray(p.media) ? p.media : [] })
            } catch {
              return null
            }
          })
      )
      return summaries.filter((s): s is ProjectSummary => s !== null).sort((a, b) => b.updatedAt - a.updatedAt)
    },

    async load(id) {
      const p = JSON.parse(await readFile(file(id), 'utf8')) as Project
      if (p.id !== id) p.id = id
      return p
    },

    async save(project) {
      const target = file(project.id)
      await mkdir(dir, { recursive: true })
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, JSON.stringify(project, null, 1), 'utf8')
      try {
        await rename(tmp, target)
      } catch (err) {
        await rm(tmp, { force: true })
        throw err
      }
    },

    async delete(id) {
      await rm(file(id), { force: true })
    }
  }
}
