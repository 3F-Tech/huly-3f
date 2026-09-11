//
// Copyright © 2022 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import { Analytics } from '@hcengineering/analytics'
import { type Person } from '@hcengineering/contact'
import core, {
  AccountRole,
  SortingOrder,
  toIdMap,
  type ApplyOperations,
  type AttachedData,
  type AttachedDoc,
  type Class,
  type Collection,
  type Doc,
  type DocumentQuery,
  type DocumentUpdate,
  type IdMap,
  type Ref,
  type Space,
  type Status,
  type StatusCategory,
  type TxCreateDoc,
  type TxOperations,
  type TxResult,
  type TxUpdateDoc,
  getCurrentAccount,
  type WithLookup
} from '@hcengineering/core'
import { type IntlString } from '@hcengineering/platform'
import { createQuery, getClient, onClient } from '@hcengineering/presentation'
import task, {
  getStatusIndex,
  makeRank,
  type TaskType,
  type TaskTypeKind,
  type ProjectType
} from '@hcengineering/task'
import {
  selectedTaskTypeStore,
  activeProjects as taskActiveProjects,
  taskTypeStore,
  typeStore,
  typesOfJoinedProjectsStore
} from '@hcengineering/task-resources'
import {
  IssuePriority,
  MilestoneStatus,
  TimeReportDayType,
  type Component,
  type Issue,
  type IssueStatus,
  type Milestone,
  type Project
} from '@hcengineering/tracker'
import { areDatesEqual, isWeekend, PaletteColorIndexes } from '@hcengineering/ui'
import { type KeyFilter, type ViewletDescriptor } from '@hcengineering/view'
import { CategoryQuery, ListSelectionProvider, statusStore, type SelectDirection } from '@hcengineering/view-resources'
import { derived, get, writable } from 'svelte/store'
import tracker from './plugin'
import { defaultMilestoneStatuses, defaultPriorities } from './types'

export const activeProjects = derived(taskActiveProjects, (projects) => {
  const client = getClient()
  return toIdMap(
    Array.from(projects.values()).filter((it) => client.getHierarchy().isDerived(it._class, tracker.class.Project))
  ) as Map<Ref<Project>, Project>
})
export * from './types'

export type ComponentsFilterMode = 'all' | 'backlog' | 'active' | 'closed'

export type MilestoneViewMode = 'all' | 'planned' | 'active' | 'closed'

export const getIncludedMilestoneStatuses = (mode: MilestoneViewMode): MilestoneStatus[] => {
  switch (mode) {
    case 'all': {
      return defaultMilestoneStatuses
    }
    case 'active': {
      return [MilestoneStatus.InProgress]
    }
    case 'planned': {
      return [MilestoneStatus.Planned]
    }
    case 'closed': {
      return [MilestoneStatus.Completed, MilestoneStatus.Canceled]
    }
    default: {
      return []
    }
  }
}

export const componentsTitleMap: Record<ComponentsFilterMode, IntlString> = Object.freeze({
  all: tracker.string.AllComponents,
  backlog: tracker.string.BacklogComponents,
  active: tracker.string.ActiveComponents,
  closed: tracker.string.ClosedComponents
})

export const milestoneTitleMap: Record<MilestoneViewMode, IntlString> = Object.freeze({
  all: tracker.string.AllMilestones,
  planned: tracker.string.PlannedMilestones,
  active: tracker.string.ActiveMilestones,
  closed: tracker.string.ClosedMilestones
})

/**
 * @public
 */
export const listIssueStatusOrder = [
  task.statusCategory.Active,
  task.statusCategory.ToDo,
  task.statusCategory.UnStarted,
  task.statusCategory.Won,
  task.statusCategory.Lost
] as const

/**
 * @public
 */
export const listIssueKanbanStatusOrder = [
  task.statusCategory.UnStarted,
  task.statusCategory.ToDo,
  task.statusCategory.Active,
  task.statusCategory.Won,
  task.statusCategory.Lost
] as const

function getTaskTypesStatusIndex (joinedTaskTypes: TaskType[], status: Ref<Status>): number {
  for (const taskType of joinedTaskTypes) {
    const indexx = taskType.statuses.indexOf(status)
    if (indexx >= 0) {
      return indexx
    }
  }
  return -1
}

export async function issueStatusSort (
  client: TxOperations,
  value: Array<Ref<IssueStatus>>,
  space: Ref<Project> | undefined,
  viewletDescriptorId?: Ref<ViewletDescriptor>
): Promise<Array<Ref<IssueStatus>>> {
  let type: ProjectType | undefined
  if (space !== undefined) {
    const _space = await client.findOne(
      task.class.Project,
      { _id: space },
      {
        lookup: {
          type: task.class.ProjectType
        }
      }
    )
    type = _space?.$lookup?.type
  }
  const joinedProjectsTypes = get(typesOfJoinedProjectsStore) ?? []
  const taskTypes = get(taskTypeStore)
  const joinedTaskTypes = Array.from(taskTypes.values()).filter(
    (taskType) => joinedProjectsTypes.includes(taskType.parent) && taskType.ofClass === tracker.class.Issue
  )
  const taskTypeId = get(selectedTaskTypeStore) ?? (joinedTaskTypes.length === 1 ? joinedTaskTypes[0]?._id : undefined)
  const taskType = taskTypeId !== undefined ? taskTypes.get(taskTypeId) : undefined

  const statuses = get(statusStore).byId
  // TODO: How we track category updates.

  if (viewletDescriptorId === tracker.viewlet.Kanban) {
    value.sort((a, b) => {
      const aVal = statuses.get(a)
      const bVal = statuses.get(b)
      const res =
        listIssueKanbanStatusOrder.indexOf(aVal?.category as Ref<StatusCategory>) -
        listIssueKanbanStatusOrder.indexOf(bVal?.category as Ref<StatusCategory>)
      if (res === 0) {
        if (taskType != null) {
          const aIndex = taskType.statuses.findIndex((p) => p === a)
          const bIndex = taskType.statuses.findIndex((p) => p === b)
          return aIndex - bIndex
        }
        if (type != null) {
          const aIndex = getStatusIndex(type, taskTypes, a)
          const bIndex = getStatusIndex(type, taskTypes, b)
          return aIndex - bIndex
        }
        const aIndex = getTaskTypesStatusIndex(joinedTaskTypes, a)
        const bIndex = getTaskTypesStatusIndex(joinedTaskTypes, b)
        return aIndex - bIndex
      }
      return res
    })
  } else {
    value.sort((a, b) => {
      const aVal = statuses.get(a) as IssueStatus
      const bVal = statuses.get(b) as IssueStatus
      const res =
        listIssueStatusOrder.indexOf(aVal?.category as Ref<StatusCategory>) -
        listIssueStatusOrder.indexOf(bVal?.category as Ref<StatusCategory>)
      if (res === 0) {
        if (taskType != null) {
          const aIndex = taskType.statuses.findIndex((p) => p === a)
          const bIndex = taskType.statuses.findIndex((p) => p === b)
          return aIndex - bIndex
        }
        if (type != null) {
          const aIndex = getStatusIndex(type, taskTypes, a)
          const bIndex = getStatusIndex(type, taskTypes, b)
          return aIndex - bIndex
        }
        const aIndex = getTaskTypesStatusIndex(joinedTaskTypes, a)
        const bIndex = getTaskTypesStatusIndex(joinedTaskTypes, b)
        return aIndex - bIndex
      }
      return res
    })
  }
  return value
}

export async function issuePrioritySort (client: TxOperations, value: IssuePriority[]): Promise<IssuePriority[]> {
  value.sort((a, b) => {
    const i1 = defaultPriorities.indexOf(a)
    const i2 = defaultPriorities.indexOf(b)

    return i2 - i1
  })
  return value
}

export async function milestoneSort (
  client: TxOperations,
  value: Array<Ref<Milestone>>
): Promise<Array<Ref<Milestone>>> {
  return await new Promise((resolve) => {
    const query = createQuery(true)
    query.query(tracker.class.Milestone, { _id: { $in: value } }, (res) => {
      const milestones = toIdMap(res)
      value.sort((a, b) => (milestones.get(b)?.targetDate ?? 0) - (milestones.get(a)?.targetDate ?? 0))
      resolve(value)
      query.unsubscribe()
    })
  })
}
export async function moveIssuesToAnotherMilestone (
  client: TxOperations,
  oldMilestone: Milestone,
  newMilestone: Milestone | undefined
): Promise<boolean> {
  try {
    // Find all Issues by Milestone
    const movedIssues = await client.findAll(tracker.class.Issue, { milestone: oldMilestone._id })

    // Update Issues by new Milestone
    const awaitedUpdates: Array<Promise<TxResult>> = []
    for (const issue of movedIssues) {
      awaitedUpdates.push(client.update(issue, { milestone: newMilestone?._id ?? null }))
    }
    await Promise.all(awaitedUpdates)

    return true
  } catch (error: any) {
    console.error(
      `Error happened while moving issues between milestones from ${oldMilestone.label} to ${
        newMilestone?.label ?? 'No Milestone'
      }: `,
      error
    )
    Analytics.handleError(error)
    return false
  }
}

export async function canEditIssue (issue?: Issue | WithLookup<Issue>): Promise<boolean> {
  const client = getClient()
  if (issue === undefined) return false

  const account = getCurrentAccount()
  const isGuest =
    account.role === AccountRole.Guest ||
    account.role === AccountRole.DocGuest ||
    account.role === AccountRole.ReadOnlyGuest

  if (!isGuest) return true

  const isCreator =
    issue.createdBy !== undefined && Array.isArray(account.socialIds) && account.socialIds.includes(issue.createdBy)

  if (isCreator) return true

  const collaborator = await client.findOne(core.class.Collaborator, {
    attachedTo: issue._id,
    collaborator: account.uuid
  })
  return collaborator !== undefined
}

export function getTimeReportDate (type: TimeReportDayType): number {
  const date = new Date(Date.now())

  if (type === TimeReportDayType.PreviousWorkDay) {
    date.setDate(date.getDate() - 1)
  }

  // if date is day off then set date to last working day
  while (isWeekend(date)) {
    date.setDate(date.getDate() - 1)
  }

  return date.valueOf()
}

export function getTimeReportDayType (timestamp: number): TimeReportDayType | undefined {
  const date = new Date(timestamp)
  const currentWorkDate = new Date(getTimeReportDate(TimeReportDayType.CurrentWorkDay))
  const previousWorkDate = new Date(getTimeReportDate(TimeReportDayType.PreviousWorkDay))

  if (areDatesEqual(date, currentWorkDate)) {
    return TimeReportDayType.CurrentWorkDay
  } else if (areDatesEqual(date, previousWorkDate)) {
    return TimeReportDayType.PreviousWorkDay
  }
}

export function subIssueQuery (value: boolean, query: DocumentQuery<Issue>): DocumentQuery<Issue> {
  return value ? query : { ...query, attachedTo: tracker.ids.NoParent }
}

async function getAllSomething (
  _class: Ref<Class<Doc>>,
  query: DocumentQuery<Doc> | undefined,
  onUpdate: () => void,
  queryId: Ref<Doc>
): Promise<any[] | undefined> {
  const promise = new Promise<Array<Ref<Doc>>>((resolve, reject) => {
    let refresh: boolean = false
    const lq = CategoryQuery.getLiveQuery(queryId)
    refresh = lq.query(_class, query ?? {}, (res) => {
      const result = res.map((p) => p._id)
      CategoryQuery.results.set(queryId, result)
      resolve(result)
      onUpdate()
    })

    if (!refresh) {
      resolve(CategoryQuery.results.get(queryId) ?? [])
    }
  })
  return await promise
}

export async function getAllPriority (
  query: DocumentQuery<Doc> | undefined,
  onUpdate: () => void,
  queryId: Ref<Doc>
): Promise<any[] | undefined> {
  return defaultPriorities
}

export async function getAllComponents (
  query: DocumentQuery<Doc> | undefined,
  onUpdate: () => void,
  queryId: Ref<Doc>
): Promise<any[] | undefined> {
  return await getAllSomething(tracker.class.Component, query, onUpdate, queryId)
}

export async function getAllMilestones (
  query: DocumentQuery<Doc> | undefined,
  onUpdate: () => void,
  queryId: Ref<Doc>
): Promise<any[] | undefined> {
  return await getAllSomething(tracker.class.Milestone, query, onUpdate, queryId)
}

export function subIssueListProvider (subIssues: Issue[], target: Ref<Issue>): void {
  const listProvider = new ListSelectionProvider((offset: 1 | -1 | 0, of?: Doc, dir?: SelectDirection) => {
    if (dir === 'vertical') {
      let pos = subIssues.findIndex((p) => p._id === of?._id)
      pos += offset
      if (pos < 0) {
        pos = 0
      }
      if (pos >= subIssues.length) {
        pos = subIssues.length - 1
      }
      listProvider.updateFocus(subIssues[pos])
    }
  }, false)
  listProvider.update(subIssues)
  const selectedIssue = subIssues.find((p) => p._id === target)
  if (selectedIssue != null) {
    listProvider.updateFocus(selectedIssue)
  }
}

export async function getPreviousAssignees (objectId: Ref<Issue> | undefined): Promise<Array<Ref<Person>>> {
  if (objectId === undefined) {
    return []
  }
  const client = getClient()
  const createTx = (
    await client.findAll<TxCreateDoc<Issue>>(core.class.TxCreateDoc, {
      objectId
    })
  )[0]
  const updateTxes = await client.findAll<TxUpdateDoc<Issue>>(
    core.class.TxUpdateDoc,
    { objectId, 'operations.assignee': { $exists: true } },
    { sort: { modifiedOn: -1 } }
  )
  const set = new Set<Ref<Person>>()
  // valores podem ser escalares (Txs antigas) ou arrays (multi-assignee)
  const addAll = (value: Ref<Person>[] | Ref<Person> | null | undefined): void => {
    if (value == null) return
    for (const v of Array.isArray(value) ? value : [value]) {
      set.add(v)
    }
  }
  for (const tx of updateTxes) {
    addAll(tx.operations.assignee as Ref<Person>[] | Ref<Person> | null | undefined)
  }
  addAll(createTx?.attributes?.assignee as Ref<Person>[] | Ref<Person> | null | undefined)
  return Array.from(set)
}

async function updateIssuesOnMove (
  client: TxOperations,
  applyOps: ApplyOperations,
  doc: Doc,
  space: Project,
  extra: DocumentUpdate<any>,
  updates: Map<Ref<Issue>, DocumentUpdate<Issue>>
): Promise<void> {
  const hierarchy = client.getHierarchy()
  const attributes = hierarchy.getAllAttributes(doc._class)
  for (const attribute of attributes.values()) {
    if (hierarchy.isDerived(attribute.type._class, core.class.Collection)) {
      const collection = attribute.type as Collection<AttachedDoc>
      const allAttached = await client.findAll(collection.of, { attachedTo: doc._id })
      for (const attached of allAttached) {
        if (hierarchy.isDerived(collection.of, tracker.class.Issue)) {
          const lastOne = await client.findOne(tracker.class.Issue, {}, { sort: { rank: SortingOrder.Descending } })
          const incResult = await client.updateDoc(
            tracker.class.Project,
            core.space.Space,
            space._id,
            {
              $inc: { sequence: 1 }
            },
            true
          )
          const number = (incResult as any).object.sequence
          await updateIssuesOnMove(
            client,
            applyOps,
            attached,
            space,
            {
              ...updates.get(attached._id as Ref<Issue>),
              rank: makeRank(lastOne?.rank, undefined),
              number,
              identifier: `${space.identifier}-${number}`
            },
            updates
          )
        } else {
          await updateIssuesOnMove(client, applyOps, attached, space, {}, updates)
        }
      }
    }
  }
  await applyOps.update(doc, {
    space: space._id,
    ...extra
  })
}

/**
 * @public
 */
export async function moveIssueToSpace (
  client: TxOperations,
  docs: Issue[],
  space: Project,
  updates: Map<Ref<Issue>, DocumentUpdate<Issue>>
): Promise<void> {
  const applyOps = client.apply()
  for (const doc of docs) {
    const lastOne = await client.findOne(tracker.class.Issue, {}, { sort: { rank: SortingOrder.Descending } })
    const incResult = await client.updateDoc(
      tracker.class.Project,
      core.space.Space,
      space._id,
      {
        $inc: { sequence: 1 }
      },
      true
    )
    const number = (incResult as any).object.sequence
    await updateIssuesOnMove(
      client,
      applyOps,
      doc,
      space,
      {
        ...updates.get(doc._id),
        rank: makeRank(lastOne?.rank, undefined),
        number,
        identifier: `${space.identifier}-${number}`
      },
      updates
    )
  }
  await applyOps.commit()
}

/**
 * @public
 *
 * Will collect all issues to be moved.
 */
export async function collectIssues (client: TxOperations, docs: Doc[]): Promise<Issue[]> {
  const result: Issue[] = []
  const hierarchy = client.getHierarchy()
  for (const doc of docs) {
    if (hierarchy.isDerived(doc._class, tracker.class.Issue)) {
      result.push(doc as Issue)
    }

    const attributes = hierarchy.getAllAttributes(doc._class)
    for (const attribute of attributes.values()) {
      if (hierarchy.isDerived(attribute.type._class, core.class.Collection)) {
        const collection = attribute.type as Collection<AttachedDoc>
        const allAttached = await client.findAll(collection.of, { attachedTo: doc._id })
        for (const attached of allAttached) {
          if (hierarchy.isDerived(collection.of, tracker.class.Issue)) {
            if (result.find((it) => it._id === attached._id) === undefined) {
              result.push(attached as Issue)
            }
          }

          const subIssues = await collectIssues(client, [attached])
          if (subIssues.length > 0) {
            for (const s of subIssues) {
              if (result.find((it) => it._id === s._id) === undefined) {
                result.push(s)
              }
            }
          }
        }
      }
    }
  }
  return result
}

/**
 * @public
 *
 * Uma linha do plano de troca de tipo: um par (tipo de tarefa, status) hoje em uso no projeto
 * e para onde ele vai no novo tipo. A chave é o PAR, não só o status: o Huly reaproveita o
 * mesmo documento de Status entre tipos de tarefa quando nome e categoria coincidem
 * (`createState`), então um projeto com mais de um tipo de tarefa costuma ter o mesmo
 * `Ref<IssueStatus>` em vários deles. Chavear só pelo status fundiria os tipos de tarefa.
 *
 * `count` inclui subtarefas de qualquer profundidade — todas compartilham o `space` do projeto.
 */
export interface StatusMigrationRow {
  fromKind: Ref<TaskType>
  from: Ref<IssueStatus>
  toKind: Ref<TaskType>
  to: Ref<IssueStatus>
  count: number
  /** Como o destino foi sugerido: nome idêntico, mesma posição dentro da categoria, ou fallback. */
  suggestedBy: 'name' | 'category' | 'fallback'
}

/**
 * @public
 *
 * As linhas de um mesmo tipo de tarefa de origem. O tipo de tarefa destino é escolhido uma vez
 * por grupo e vale para todas as linhas dele.
 */
export interface StatusMigrationGroup {
  fromKind: Ref<TaskType>
  fromKindName: string
  toKind: Ref<TaskType>
  count: number
  rows: StatusMigrationRow[]
}

/**
 * @public
 */
export interface StatusMigrationPlan {
  /** De-para sugerido, agrupado por tipo de tarefa de origem. */
  groups: StatusMigrationGroup[]
  /** Tipos de tarefa de Issue do novo tipo, na ordem do tipo. */
  targetTaskTypes: TaskType[]
  /** Status de cada tipo de tarefa do novo tipo, na ordem declarada. */
  statusesByTaskType: Map<Ref<TaskType>, Array<Ref<IssueStatus>>>
  /** Status inicial do novo tipo (vira o `defaultIssueStatus` do projeto). */
  initial: Ref<IssueStatus>
  /** Total de tarefas do projeto. */
  total: number
}

/**
 * @public
 */
export interface StatusMigrationTarget {
  kind: Ref<TaskType>
  status: Ref<IssueStatus>
}

/**
 * @public
 *
 * De-para da migração, indexado por `statusMigrationKey(kind, status)` de origem.
 */
export type StatusMigrationMapping = Map<string, StatusMigrationTarget>

/**
 * @public
 *
 * Chave de uma tarefa no de-para: o par (tipo de tarefa, status).
 */
export function statusMigrationKey (kind: Ref<TaskType> | undefined, status: Ref<IssueStatus>): string {
  return `${kind ?? ''}|${status}`
}

/**
 * @public
 */
export interface ChangeProjectTypeOptions {
  /** De-para explícito (ver `buildStatusMigrationPlan`). Pares ausentes usam o fallback por categoria. */
  mapping?: StatusMigrationMapping
  /** Status inicial do novo tipo; usado como fallback e como `defaultIssueStatus` do projeto. */
  preferredInitial?: Ref<IssueStatus>
  /** Chamado a cada lote gravado, para a UI mostrar progresso. */
  onProgress?: (done: number, total: number) => void
  /** Tamanho do lote e pausa entre lotes. Os defaults são calibrados para não saturar o transactor. */
  batchSize?: number
  pauseMs?: number
}

/**
 * Quantas issues por `apply`, e quanto esperar entre um lote e o outro.
 *
 * Cada update de issue acorda uma cadeia de triggers no transactor — `isDone` (task), ToDo do
 * Planner (time, em projeto classic), datas automáticas —, e vários deles fazem consultas
 * próprias. Um lote grande vira um único tx que ocupa o transactor por muito tempo, que é
 * justamente como o workspace já congelou antes (fila de requisições entupida). Lote curto com
 * pausa deixa o transactor atender os outros usuários entre um lote e outro: a migração demora
 * alguns minutos, mas ninguém fica travado enquanto ela roda.
 */
const CHANGE_TYPE_BATCH = 25
const CHANGE_TYPE_PAUSE_MS = 5000

async function pause (ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/**
 * @public
 *
 * Estimativa grosseira, em minutos, de quanto a migração vai levar: as pausas entre lotes mais
 * uma folga por lote para o processamento. Serve para avisar o usuário que ele precisa deixar a
 * janela aberta — não é promessa de prazo.
 */
export function estimateMigrationMinutes (
  total: number,
  batchSize: number = CHANGE_TYPE_BATCH,
  pauseMs: number = CHANGE_TYPE_PAUSE_MS
): number {
  const batches = Math.ceil(total / Math.max(1, batchSize))
  return Math.max(1, Math.ceil((batches * (pauseMs + 1000)) / 60000))
}

/** Nome comparável: sem acento, sem caixa, sem espaço nas pontas. */
function normalizeTypeName (name: string | undefined): string {
  return (name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
}

function notEmptyValue<T> (value: T | undefined): value is T {
  return value !== undefined
}

/** TaskTypes de Issue de um ProjectType, na ordem declarada pelo tipo. */
function getIssueTaskTypes (type: ProjectType): TaskType[] {
  const all = get(taskTypeStore)
  const ordered = type.tasks.map((it) => all.get(it)).filter(notEmptyValue)
  for (const tt of all.values()) {
    if (tt.parent === type._id && !ordered.some((it) => it._id === tt._id)) {
      ordered.push(tt)
    }
  }
  return ordered.filter((tt) => tt.ofClass === tracker.class.Issue)
}

interface ResolvedTargetType {
  type: ProjectType
  taskTypes: TaskType[]
  statusesByTaskType: Map<Ref<TaskType>, Array<Ref<IssueStatus>>>
  initial: Ref<IssueStatus>
}

/** Resolve tudo que depende do novo tipo: tipos de tarefa, seus status e o status inicial. */
function resolveTargetType (newTypeId: Ref<ProjectType>, preferredInitial?: Ref<IssueStatus>): ResolvedTargetType {
  const type = get(typeStore).get(newTypeId)
  if (type === undefined) {
    throw new Error(`Project type ${newTypeId} not found`)
  }
  const taskTypes = getIssueTaskTypes(type)
  if (taskTypes.length === 0) {
    throw new Error(`No issue task type found for project type ${newTypeId}`)
  }

  const statusesByTaskType = new Map<Ref<TaskType>, Array<Ref<IssueStatus>>>()
  for (const tt of taskTypes) {
    statusesByTaskType.set(tt._id, tt.statuses as Array<Ref<IssueStatus>>)
  }
  const first = statusesByTaskType.get(taskTypes[0]._id) ?? []
  if (first.length === 0) {
    throw new Error(`Task type ${taskTypes[0]._id} has no statuses`)
  }

  const allStatuses = taskTypes.flatMap((tt) => tt.statuses as Array<Ref<IssueStatus>>)
  const initial =
    preferredInitial !== undefined && allStatuses.includes(preferredInitial) ? preferredInitial : first[0]

  return { type, taskTypes, statusesByTaskType, initial }
}

/**
 * Todo tipo de tarefa tem um papel (`TaskType.kind`): serve como tarefa, como subtarefa, ou como
 * ambos — é o "Tarefa / Sub-Tarefa / Tarefa e Sub-Tarefa" da tela de configuração do tipo de
 * projeto. Mandar tarefas de um papel para um tipo do papel oposto deixaria o projeto
 * inconsistente, então só tratamos como candidatos os papéis compatíveis.
 */
function taskKindsCompatible (from: TaskTypeKind, to: TaskTypeKind): boolean {
  return from === to || from === 'both' || to === 'both'
}

/**
 * Casa um tipo de tarefa de origem com um do destino:
 *  1. mesmo nome (sem acento, sem caixa) — é o mesmo tipo, independente do papel;
 *  2. entre os de papel compatível, preferindo papel idêntico, o de mesma posição relativa;
 *  3. o primeiro candidato compatível.
 */
function suggestTaskType (from: TaskType | undefined, sources: TaskType[], targets: TaskType[]): Ref<TaskType> {
  if (from === undefined) {
    return targets[0]._id
  }

  const name = normalizeTypeName(from.name)
  const byName = targets.find((it) => normalizeTypeName(it.name) === name)
  if (byName !== undefined) {
    return byName._id
  }

  const compatible = targets.filter((it) => taskKindsCompatible(from.kind, it.kind))
  const pool = compatible.length > 0 ? compatible : targets
  const sameRole = pool.filter((it) => it.kind === from.kind)
  const preferred = sameRole.length > 0 ? sameRole : pool

  // Posição relativa entre os tipos de MESMO papel, para não comparar tarefa com subtarefa.
  const peers = sources.filter((it) => it.kind === from.kind)
  const idx = peers.findIndex((it) => it._id === from._id)
  if (idx >= 0 && idx < preferred.length) {
    return preferred[idx]._id
  }

  return preferred[0]._id
}

/**
 * Sugere o status destino DENTRO de um tipo de tarefa já escolhido:
 *  1. mesmo nome (sem acento, sem caixa);
 *  2. mesma categoria e mesma posição relativa dentro dela;
 *  3. primeiro status do tipo de tarefa destino.
 */
function suggestTargetStatus (
  from: Status | undefined,
  sourceDocs: Status[],
  targetDocs: Status[],
  fallback: Ref<IssueStatus>
): { to: Ref<IssueStatus>, suggestedBy: StatusMigrationRow['suggestedBy'] } {
  if (from === undefined || targetDocs.length === 0) {
    return { to: fallback, suggestedBy: 'fallback' }
  }

  const name = normalizeTypeName(from.name)
  const byName = targetDocs.find((it) => normalizeTypeName(it.name) === name)
  if (byName !== undefined) {
    return { to: byName._id as Ref<IssueStatus>, suggestedBy: 'name' }
  }

  const category = from.category
  if (category !== undefined) {
    const targetSiblings = targetDocs.filter((it) => it.category === category)
    if (targetSiblings.length > 0) {
      const sourceSiblings = sourceDocs.filter((it) => it.category === category)
      const idx = Math.max(
        0,
        sourceSiblings.findIndex((it) => it._id === from._id)
      )
      const picked = targetSiblings[Math.min(idx, targetSiblings.length - 1)]
      return { to: picked._id as Ref<IssueStatus>, suggestedBy: 'category' }
    }
  }

  return { to: fallback, suggestedBy: 'fallback' }
}

/**
 * @public
 *
 * Monta o de-para sugerido para trocar `project` para `newTypeId`, contando quantas tarefas
 * existem em cada par (tipo de tarefa, status) — subtarefas de qualquer profundidade incluídas,
 * já que todas compartilham o `space` do projeto.
 *
 * O plano vem agrupado por tipo de tarefa de origem: cada grupo aponta para um tipo de tarefa do
 * novo tipo (casado por nome, senão por posição), e dentro dele cada status ganha um destino
 * sugerido. O usuário revisa isso uma vez e vale para todas as tarefas.
 */
export async function buildStatusMigrationPlan (
  client: TxOperations,
  project: Project,
  newTypeId: Ref<ProjectType>,
  preferredInitial?: Ref<IssueStatus>
): Promise<StatusMigrationPlan> {
  const { taskTypes: targetTaskTypes, statusesByTaskType, initial } = resolveTargetType(newTypeId, preferredInitial)
  const byId = get(statusStore).byId
  const allTaskTypes = get(taskTypeStore)

  // Contagem por par (kind, status). Projeção mínima: só o que decide a migração.
  const issues = await client.findAll(
    tracker.class.Issue,
    { space: project._id },
    { projection: { _id: 1, status: 1, kind: 1 } }
  )
  const counts = new Map<string, { kind: Ref<TaskType>, status: Ref<IssueStatus>, count: number }>()
  for (const issue of issues) {
    const key = statusMigrationKey(issue.kind, issue.status)
    const entry = counts.get(key)
    if (entry !== undefined) {
      entry.count++
    } else {
      counts.set(key, { kind: issue.kind, status: issue.status, count: 1 })
    }
  }

  // Ordem de exibição dos tipos de tarefa: a do tipo atual; tipos legados entram no fim.
  const currentType = get(typeStore).get(project.type)
  const sourceTaskTypes = currentType !== undefined ? getIssueTaskTypes(currentType) : []
  const orderedKinds: Array<Ref<TaskType>> = sourceTaskTypes.map((it) => it._id)
  for (const { kind } of counts.values()) {
    if (!orderedKinds.includes(kind)) {
      orderedKinds.push(kind)
    }
  }

  const groups: StatusMigrationGroup[] = []
  for (const kind of orderedKinds) {
    const entries = Array.from(counts.values()).filter((it) => it.kind === kind)
    // Tipo de tarefa do tipo atual sem nenhuma tarefa não exige decisão do usuário.
    if (entries.length === 0) continue

    const sourceTaskType = allTaskTypes.get(kind)
    const toKind = suggestTaskType(sourceTaskType, sourceTaskTypes, targetTaskTypes)

    // Ordem dos status dentro do grupo: a do tipo de tarefa de origem; legados no fim.
    const orderedStatuses = (sourceTaskType?.statuses ?? []) as Array<Ref<IssueStatus>>
    const sorted = [...entries].sort((a, b) => {
      const ia = orderedStatuses.indexOf(a.status)
      const ib = orderedStatuses.indexOf(b.status)
      return (ia === -1 ? Number.MAX_SAFE_INTEGER : ia) - (ib === -1 ? Number.MAX_SAFE_INTEGER : ib)
    })

    const rows = sorted.map((entry) => ({
      fromKind: kind,
      from: entry.status,
      toKind,
      count: entry.count,
      ...suggestRowTarget(entry.status, sourceTaskType, toKind, statusesByTaskType, byId, initial)
    }))

    groups.push({
      fromKind: kind,
      fromKindName: sourceTaskType?.name ?? '',
      toKind,
      count: entries.reduce((sum, it) => sum + it.count, 0),
      rows
    })
  }

  return { groups, targetTaskTypes, statusesByTaskType, initial, total: issues.length }
}

/**
 * @public
 *
 * Destino sugerido de um status, dado o tipo de tarefa destino já escolhido. Exposto para a UI
 * poder re-sugerir as linhas de um grupo quando o usuário troca o tipo de tarefa destino dele.
 */
export function suggestRowTarget (
  from: Ref<IssueStatus>,
  sourceTaskType: TaskType | undefined,
  toKind: Ref<TaskType>,
  statusesByTaskType: Map<Ref<TaskType>, Array<Ref<IssueStatus>>>,
  byId: IdMap<Status>,
  initial: Ref<IssueStatus>
): { to: Ref<IssueStatus>, suggestedBy: StatusMigrationRow['suggestedBy'] } {
  const targetIds = statusesByTaskType.get(toKind) ?? []
  const targetDocs = targetIds.map((id) => byId.get(id)).filter(notEmptyValue)
  const sourceDocs = ((sourceTaskType?.statuses ?? []) as Array<Ref<IssueStatus>>)
    .map((id) => byId.get(id))
    .filter(notEmptyValue)
  const fallback = targetIds[0] ?? initial
  return suggestTargetStatus(byId.get(from), sourceDocs, targetDocs, fallback)
}

/**
 * @public
 *
 * Troca o ProjectType de um projeto existente, remapeando todas as issues (e templates) do
 * projeto para o `kind`/`status` válidos do novo tipo. O destino de cada tarefa vem do `mapping`
 * pelo par (tipo de tarefa, status) — montado por `buildStatusMigrationPlan` e revisado pelo
 * usuário na UI. Pares ausentes caem no fallback por categoria dentro do tipo de tarefa casado
 * por nome: "Won" → primeiro "Won", "Lost" → primeiro "Lost", qualquer outro → primeiro status.
 *
 * Tarefas que já estão num par (tipo de tarefa, status) válido do novo tipo são deixadas como
 * estão, o que torna a operação repetível: se ela falhar no meio, rodar de novo termina o
 * serviço sem estragar o que já migrou.
 *
 * O update de cada tarefa grava `status` e `kind` juntos — é essa assinatura que faz os triggers
 * de conclusão (F01) e de datas automáticas pularem a tarefa, já que não se trata de alguém
 * concluindo nada, e sim do workflow inteiro sendo trocado.
 *
 * As roles do tipo anterior NÃO são migradas (papéis pertencem ao ProjectType); apenas garantimos
 * o mixin do novo `targetClass` para o projeto continuar consistente. As tarefas são gravadas em
 * lotes de `CHANGE_TYPE_BATCH` (cada lote é um `apply` atômico) para não montar um tx gigante.
 */
export async function changeProjectType (
  client: TxOperations,
  project: Project,
  newTypeId: Ref<ProjectType>,
  options: ChangeProjectTypeOptions = {}
): Promise<void> {
  const {
    mapping,
    preferredInitial,
    onProgress,
    batchSize = CHANGE_TYPE_BATCH,
    pauseMs = CHANGE_TYPE_PAUSE_MS
  } = options
  const hierarchy = client.getHierarchy()
  const {
    type: newType,
    taskTypes,
    statusesByTaskType,
    initial
  } = resolveTargetType(newTypeId, preferredInitial)

  const byId = get(statusStore).byId
  const allTaskTypes = get(taskTypeStore)
  const currentType = get(typeStore).get(project.type)
  const sourceTaskTypes = currentType !== undefined ? getIssueTaskTypes(currentType) : []
  const defaultTaskType = taskTypes[0]

  const isValidTarget = (kind: Ref<TaskType>, status: Ref<IssueStatus>): boolean =>
    statusesByTaskType.get(kind)?.includes(status) ?? false

  /** Fallback: casa o tipo de tarefa por nome e, dentro dele, o status pela categoria. */
  const fallbackFor = (issue: Issue): StatusMigrationTarget => {
    const kind = suggestTaskType(allTaskTypes.get(issue.kind), sourceTaskTypes, taskTypes)
    const targetIds = statusesByTaskType.get(kind) ?? []
    const category = byId.get(issue.status)?.category
    const byCategory =
      category !== undefined ? targetIds.find((s) => byId.get(s)?.category === category) : undefined
    return { kind, status: byCategory ?? targetIds[0] ?? initial }
  }

  // Todas as issues do projeto — subtarefas de qualquer profundidade compartilham o mesmo space.
  const issues = await client.findAll(tracker.class.Issue, { space: project._id })
  const pending = issues.filter((issue) => !isValidTarget(issue.kind, issue.status))

  let done = 0
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize)
    const applyOps = client.apply('change-project-type')
    for (const issue of batch) {
      const mapped = mapping?.get(statusMigrationKey(issue.kind, issue.status))
      const target = mapped !== undefined && isValidTarget(mapped.kind, mapped.status) ? mapped : fallbackFor(issue)
      if (issue.status !== target.status || issue.kind !== target.kind) {
        // status e kind juntos: ver nota sobre os triggers no doc desta função.
        await applyOps.update(issue, { status: target.status, kind: target.kind })
      }
    }
    await applyOps.commit()
    done += batch.length
    onProgress?.(done, pending.length)

    // Respira entre lotes para o transactor atender os outros usuários.
    if (done < pending.length && pauseMs > 0) {
      await pause(pauseMs)
    }
  }

  // Templates: só o kind (templates não guardam status de execução). Casa por nome do tipo de tarefa.
  const templates = await client.findAll(tracker.class.IssueTemplate, { space: project._id })
  if (templates.length > 0) {
    const applyOps = client.apply('change-project-type-templates')
    for (const template of templates) {
      const newKind =
        template.kind !== undefined
          ? suggestTaskType(allTaskTypes.get(template.kind), sourceTaskTypes, taskTypes)
          : defaultTaskType._id
      if (template.kind !== newKind) {
        await applyOps.update(template, { kind: newKind })
      }
    }
    await applyOps.commit()
  }

  await client.update(project, { type: newTypeId, defaultIssueStatus: initial })

  // Garante o mixin do targetClass do novo tipo (guarda roles/atributos por tipo)
  if (!hierarchy.hasMixin(project, newType.targetClass)) {
    await client.createMixin(project._id, tracker.class.Project, core.space.Space, newType.targetClass, {})
  }
}

/**
 * @public
 */
export function issueToAttachedData (issue: Issue): AttachedData<Issue> {
  const { _id, _class, space, ...data } = issue
  return { ...data }
}

/**
 * @public
 */
export const IssuePriorityColor = {
  [IssuePriority.NoPriority]: PaletteColorIndexes.Blueberry,
  [IssuePriority.Urgent]: PaletteColorIndexes.Orange,
  [IssuePriority.High]: PaletteColorIndexes.Sunshine,
  [IssuePriority.Medium]: PaletteColorIndexes.Ocean,
  [IssuePriority.Low]: PaletteColorIndexes.Cloud
}

export async function getVisibleFilters (filters: KeyFilter[], space?: Ref<Space>): Promise<KeyFilter[]> {
  // Removes the "Project" filter if a specific space is provided
  return space === undefined ? filters : filters.filter((f) => f.key !== 'space')
}

export function getIssueChatTitle (object: Issue): string {
  return object.title
}

export function getIssueStatusCategories (project: ProjectType): Array<Ref<StatusCategory>> {
  if (project.classic) {
    return [
      task.statusCategory.UnStarted,
      task.statusCategory.ToDo,
      task.statusCategory.Active,
      task.statusCategory.Won,
      task.statusCategory.Lost
    ]
  } else {
    return [
      task.statusCategory.UnStarted,
      task.statusCategory.Active,
      task.statusCategory.Won,
      task.statusCategory.Lost
    ]
  }
}

interface ManualUpdates {
  useStatus: boolean
  useComponent: boolean
  createStatus: boolean
  createComponent: boolean
}
export type IssueToUpdate = DocumentUpdate<Issue> & Partial<ManualUpdates>

export interface ComponentToUpdate {
  ref: Ref<Component>
  create?: boolean
}

export async function getComponentTitle (client: TxOperations, ref: Ref<Component>): Promise<string> {
  const object = await client.findOne(tracker.class.Component, { _id: ref })

  return object?.label ?? ''
}

export async function getMilestoneTitle (client: TxOperations, ref: Ref<Milestone>): Promise<string> {
  const object = await client.findOne(tracker.class.Milestone, { _id: ref })

  return object?.label ?? ''
}

export interface IssueRef {
  status: Ref<Status>
  _id: Ref<Issue>
}
export type IssueReverseRevMap = Map<Ref<Doc>, IssueRef[]>
export const relatedIssues = writable<IssueReverseRevMap>(new Map())

const relatedIssuesQuery = createQuery(true)
onClient(() => {
  relatedIssuesQuery.query(
    tracker.class.Issue,
    { 'relations._id': { $exists: true } },
    (res) => {
      const nMap: IssueReverseRevMap = new Map()
      for (const r of res) {
        for (const rr of r.relations ?? []) {
          nMap.set(rr._id, [...(nMap.get(rr._id) ?? []), { _id: r._id, status: r.status }])
        }
      }
      relatedIssues.set(nMap)
    },
    {
      projection: {
        relations: 1,
        status: 1
      }
    }
  )
})
