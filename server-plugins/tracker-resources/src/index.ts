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

import chunter, { ChatMessage } from '@hcengineering/chunter'
import { Person } from '@hcengineering/contact'
import core, {
  concatLink,
  Doc,
  DocumentUpdate,
  Ref,
  Space,
  Timestamp,
  Tx,
  TxCreateDoc,
  TxCUD,
  TxProcessor,
  TxRemoveDoc,
  TxUpdateDoc,
  WithLookup
} from '@hcengineering/core'
import { NotificationContent } from '@hcengineering/notification'
import { getMetadata, IntlString } from '@hcengineering/platform'
import serverCore, { TriggerControl, QueueTopic } from '@hcengineering/server-core'
import { NOTIFICATION_BODY_SIZE } from '@hcengineering/server-notification'
import task from '@hcengineering/task'
import { stripTags } from '@hcengineering/text-core'
import tracker, {
  Component,
  CompletionRule,
  Issue,
  IssueCompletionConfig,
  IssueParentInfo,
  IssueStatus,
  PdcaFrequency,
  TimeSpendReport,
  trackerId,
  type Project
} from '@hcengineering/tracker'
import { workbenchId } from '@hcengineering/workbench'

async function updateSubIssues (
  updateTx: TxUpdateDoc<Issue>,
  control: TriggerControl,
  update: DocumentUpdate<Issue> | ((node: Issue) => DocumentUpdate<Issue>)
): Promise<TxUpdateDoc<Issue>[]> {
  const subIssues = await control.findAll(control.ctx, tracker.class.Issue, { 'parents.parentId': updateTx.objectId })

  return subIssues.map((issue) => {
    const docUpdate = typeof update === 'function' ? update(issue) : update
    return control.txFactory.createTxUpdateDoc(issue._class, issue.space, issue._id, docUpdate)
  })
}

/**
 * Rótulo exibido para a issue em notificações (email/push). Quando a issue tem
 * "Nome do Cliente" (F09) preenchido, usa o nome do cliente no lugar do
 * identificador (ex.: SUPOR-97); o identificador permanece como fallback.
 * @public
 */
export function getIssueNotificationLabel (issue: Issue): string {
  const clientName = (issue as unknown as { clientName?: string }).clientName
  return clientName != null && clientName.trim().length > 0 ? clientName : issue.identifier
}

/**
 * @public
 */
export async function issueHTMLPresenter (doc: Doc, control: TriggerControl): Promise<string> {
  const issue = doc as Issue
  const front = control.branding?.front ?? getMetadata(serverCore.metadata.FrontUrl) ?? ''
  const path = `${workbenchId}/${control.workspace.url}/${trackerId}/${issue.identifier}`
  const link = concatLink(front, path)
  return `<a href="${link}">${getIssueNotificationLabel(issue)}</a> ${issue.title}`
}

/**
 * @public
 */
export async function getIssueId (doc: Issue, control: TriggerControl): Promise<string> {
  const issue = doc
  const project = (await control.findAll(control.ctx, tracker.class.Project, { _id: issue.space }))[0]
  return `${project?.identifier ?? '?'}-${issue.number}`
}

/**
 * @public
 */
export async function issueTextPresenter (doc: Doc): Promise<string> {
  const issue = doc as Issue
  return `${getIssueNotificationLabel(issue)} ${issue.title}`
}

/**
 * @public
 */
export async function getIssueNotificationContent (
  doc: Doc,
  tx: TxCUD<Doc>,
  target: Ref<Person>,
  control: TriggerControl
): Promise<NotificationContent> {
  const issue = doc as Issue

  const issueTitle = await issueTextPresenter(doc)

  const title = tracker.string.IssueNotificationTitle
  let body = tracker.string.IssueNotificationBody
  const intlParams: Record<string, string | number> = {
    issueTitle
  }
  const intlParamsNotLocalized: Record<string, IntlString> = {}

  if (tx._class === core.class.TxCreateDoc) {
    if (tx.objectClass === chunter.class.ChatMessage) {
      const createTx = tx as TxCreateDoc<ChatMessage>
      const message = createTx.attributes.message
      const plainTextMessage = stripTags(message, NOTIFICATION_BODY_SIZE)
      intlParams.message = plainTextMessage
    }
  } else if (tx._class === core.class.TxUpdateDoc) {
    const updateTx = tx as TxUpdateDoc<Issue>

    if (
      updateTx.operations.assignee !== null &&
      updateTx.operations.assignee !== undefined &&
      Array.isArray(updateTx.operations.assignee) &&
      updateTx.operations.assignee.includes(target)
    ) {
      body = tracker.string.IssueAssignedToYou
    } else {
      const attributes = control.hierarchy.getAllAttributes(doc._class)
      for (const attrName in updateTx.operations) {
        if (!Object.prototype.hasOwnProperty.call(updateTx.operations, attrName)) {
          continue
        }

        const attr = attributes.get(attrName)
        if (attr !== null && attr !== undefined) {
          intlParamsNotLocalized.property = attr.label
          if (attr.type._class === core.class.TypeString) {
            body = tracker.string.IssueNotificationChangedProperty
            intlParams.newValue = (issue as any)[attr.name]?.toString()
          } else {
            body = tracker.string.IssueNotificationChanged
          }
        }
        break
      }
    }
  }

  return {
    title,
    body,
    intlParams,
    intlParamsNotLocalized
  }
}

/**
 * @public
 */
export async function OnProjectRemove (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  for (const tx of txes) {
    const ctx = tx as TxRemoveDoc<Project>
    const classes = [tracker.class.Issue, tracker.class.Component, tracker.class.Milestone, tracker.class.IssueTemplate]
    for (const cls of classes) {
      const docs = await control.findAll(control.ctx, cls, { space: ctx.objectId })
      for (const doc of docs) {
        const tx = control.txFactory.createTxRemoveDoc(cls, doc.space, doc._id)
        result.push(tx)
      }
    }
  }
  control.ctx.contextData.broadcast.targets.projectRemove = async (it) => {
    return {
      target: []
    }
  }
  return result
}

/**
 * @public
 */
export async function OnComponentRemove (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  for (const tx of txes) {
    const ctx = tx as TxRemoveDoc<Component>

    const issues = await control.findAll(control.ctx, tracker.class.Issue, {
      component: ctx.objectId
    })
    if (issues === undefined) {
      continue
    }
    for (const issue of issues) {
      const issuePush = {
        ...issue,
        component: null
      }
      const tx = control.txFactory.createTxUpdateDoc(issue._class, issue.space, issue._id, issuePush)
      result.push(tx)
    }
  }
  return result
}

/**
 * @public
 */
export async function OnIssueUpdate (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  for (const actualTx of txes) {
    // Check TimeReport operations
    if (
      actualTx._class === core.class.TxCreateDoc ||
      actualTx._class === core.class.TxUpdateDoc ||
      actualTx._class === core.class.TxRemoveDoc
    ) {
      const cud = actualTx as TxCUD<TimeSpendReport>
      if (cud.objectClass === tracker.class.TimeSpendReport) {
        result.push(...(await doTimeReportUpdate(cud, control)))
      }
    }

    if (actualTx._class === core.class.TxCreateDoc) {
      const createTx = actualTx as TxCreateDoc<Issue>
      if (control.hierarchy.isDerived(createTx.objectClass, tracker.class.Issue)) {
        const issue = TxProcessor.createDoc2Doc(createTx)
        updateIssueParentEstimations(issue, result, control, [], issue.parents)
        continue
      }
    }

    if (actualTx._class === core.class.TxUpdateDoc) {
      const updateTx = actualTx as TxUpdateDoc<Issue>
      if (control.hierarchy.isDerived(updateTx.objectClass, tracker.class.Issue)) {
        result.push(...(await doIssueUpdate(updateTx, control)))
        continue
      }
    }
    if (actualTx._class === core.class.TxRemoveDoc) {
      const removeTx = actualTx as TxRemoveDoc<Issue>
      if (control.hierarchy.isDerived(removeTx.objectClass, tracker.class.Issue)) {
        const parentIssue = await control.findAll(control.ctx, tracker.class.Issue, {
          'childInfo.childId': removeTx.objectId
        })
        const parents: IssueParentInfo[] = parentIssue.map((it) => ({
          parentId: it._id,
          parentTitle: it.title,
          identifier: it.identifier,
          space: it.space
        }))
        updateIssueParentEstimations(
          {
            _id: removeTx.objectId,
            estimation: 0,
            reportedTime: 0,
            space: removeTx.space
          },
          result,
          control,
          parents,
          []
        )
      }
    }
  }
  return result
}

async function doTimeReportUpdate (cud: TxCUD<TimeSpendReport>, control: TriggerControl): Promise<Tx[]> {
  const { attachedTo: attachedToId, attachedToClass } = cud
  if (attachedToClass === undefined || attachedToId === undefined) {
    return []
  }
  const attachedTo = attachedToId as Ref<Issue>
  switch (cud._class) {
    case core.class.TxCreateDoc: {
      const ccud = cud as TxCreateDoc<TimeSpendReport>
      const [currentIssue] = await control.findAll(control.ctx, tracker.class.Issue, { _id: attachedTo }, { limit: 1 })
      const res = [
        control.txFactory.createTxUpdateDoc<Issue>(
          attachedToClass,
          cud.objectSpace,
          attachedTo,
          {
            $inc: { reportedTime: ccud.attributes.value }
          },
          false,
          currentIssue.modifiedOn
        )
      ]
      currentIssue.reportedTime += ccud.attributes.value
      currentIssue.remainingTime = Math.max(0, currentIssue.estimation - currentIssue.reportedTime)
      updateIssueParentEstimations(currentIssue, res, control, currentIssue.parents, currentIssue.parents)
      return res
    }
    case core.class.TxUpdateDoc: {
      const upd = cud as TxUpdateDoc<TimeSpendReport>
      if (upd.operations.value !== undefined) {
        const logTxes = Array.from(
          await control.findAll(control.ctx, core.class.TxCUD, {
            objectId: cud.objectId
          })
        ).filter((it) => it._id !== cud._id)
        const doc = TxProcessor.buildDoc2Doc<TimeSpendReport>(logTxes)

        const res: Tx[] = []
        const [currentIssue] = await control.findAll(
          control.ctx,
          tracker.class.Issue,
          { _id: attachedTo },
          { limit: 1 }
        )
        if (doc != null) {
          res.push(
            control.txFactory.createTxUpdateDoc<Issue>(
              attachedToClass,
              cud.objectSpace,
              attachedTo,
              {
                $inc: { reportedTime: upd.operations.value - doc.value }
              },
              false,
              currentIssue.modifiedOn
            )
          )
          currentIssue.reportedTime -= doc.value
          currentIssue.reportedTime += upd.operations.value
          currentIssue.remainingTime = Math.max(0, currentIssue.estimation - currentIssue.reportedTime)
        }

        updateIssueParentEstimations(currentIssue, res, control, currentIssue.parents, currentIssue.parents)
        return res
      }
      break
    }
    case core.class.TxRemoveDoc: {
      if (!control.removedMap.has(attachedTo)) {
        const logTxes = Array.from(
          await control.findAll(control.ctx, core.class.TxCUD, {
            objectId: cud.objectId
          })
        ).filter((it) => it._id !== cud._id)
        const doc = TxProcessor.buildDoc2Doc<TimeSpendReport>(logTxes)
        if (doc != null) {
          const [currentIssue] = await control.findAll(
            control.ctx,
            tracker.class.Issue,
            { _id: attachedTo },
            { limit: 1 }
          )
          const res = [
            control.txFactory.createTxUpdateDoc<Issue>(
              attachedToClass,
              cud.objectSpace,
              attachedTo,
              {
                $inc: { reportedTime: -1 * doc.value }
              },
              false,
              currentIssue.modifiedOn
            )
          ]
          currentIssue.reportedTime -= doc.value
          currentIssue.remainingTime = Math.max(0, currentIssue.estimation - currentIssue.reportedTime)
          updateIssueParentEstimations(currentIssue, res, control, currentIssue.parents, currentIssue.parents)
          return res
        }
      }
    }
  }
  return []
}

async function doIssueUpdate (updateTx: TxUpdateDoc<Issue>, control: TriggerControl): Promise<Tx[]> {
  const res: Tx[] = []

  let currentIssue: WithLookup<Issue> | undefined

  async function getCurrentIssue (): Promise<WithLookup<Issue>> {
    if (currentIssue !== undefined) {
      return currentIssue
    }
    // We need to remove estimation information from out parent issue
    ;[currentIssue] = await control.findAll(control.ctx, tracker.class.Issue, { _id: updateTx.objectId }, { limit: 1 })
    return currentIssue
  }

  if (Object.prototype.hasOwnProperty.call(updateTx.operations, 'attachedTo')) {
    const [newParent] = await control.findAll(
      control.ctx,
      tracker.class.Issue,
      { _id: updateTx.operations.attachedTo as Ref<Issue> },
      { limit: 1 }
    )

    const updatedParents: IssueParentInfo[] =
      newParent !== undefined
        ? [
            {
              parentId: newParent._id,
              parentTitle: newParent.title,
              space: newParent.space,
              identifier: newParent.identifier
            },
            ...newParent.parents
          ]
        : []

    function update (issue: Issue): DocumentUpdate<Issue> {
      const parentInfoIndex = issue.parents.findIndex(({ parentId }) => parentId === updateTx.objectId)
      const parentsUpdate =
        parentInfoIndex === -1
          ? {}
          : { parents: [...issue.parents].slice(0, parentInfoIndex + 1).concat(updatedParents) }

      return { ...parentsUpdate }
    }

    res.push(
      control.txFactory.createTxUpdateDoc(updateTx.objectClass, updateTx.objectSpace, updateTx.objectId, {
        parents: updatedParents
      }),
      ...(await updateSubIssues(updateTx, control, update))
    )

    // Remove from parent estimation list.
    const issue = await getCurrentIssue()
    updateIssueParentEstimations(issue, res, control, issue.parents, updatedParents)
  }

  if (
    Object.prototype.hasOwnProperty.call(updateTx.operations, 'estimation') ||
    Object.prototype.hasOwnProperty.call(updateTx.operations, 'reportedTime') ||
    (Object.prototype.hasOwnProperty.call(updateTx.operations, '$inc') &&
      Object.prototype.hasOwnProperty.call(updateTx.operations.$inc, 'reportedTime'))
  ) {
    const issue = await getCurrentIssue()

    issue.estimation = updateTx.operations.estimation ?? issue.estimation
    issue.reportedTime = updateTx.operations.reportedTime ?? issue.reportedTime
    issue.remainingTime = Math.max(0, issue.estimation - issue.reportedTime)

    res.push(
      control.txFactory.createTxUpdateDoc(tracker.class.Issue, issue.space, issue._id, {
        remainingTime: issue.remainingTime
      })
    )

    updateIssueParentEstimations(issue, res, control, issue.parents, issue.parents)
  }

  if (Object.prototype.hasOwnProperty.call(updateTx.operations, 'title')) {
    function update (issue: Issue): DocumentUpdate<Issue> {
      const parentInfoIndex = issue.parents.findIndex(({ parentId }) => parentId === updateTx.objectId)
      const updatedParentInfo = { ...issue.parents[parentInfoIndex], parentTitle: updateTx.operations.title as string }
      const updatedParents = [...issue.parents]

      updatedParents[parentInfoIndex] = updatedParentInfo

      return { parents: updatedParents }
    }

    res.push(...(await updateSubIssues(updateTx, control, update)))
  }

  return res
}
function updateIssueParentEstimations (
  issue: {
    _id: Ref<Issue>
    space: Ref<Space>
    estimation: number
    reportedTime: number
  },
  res: Tx[],
  control: TriggerControl,
  sourceParents: IssueParentInfo[],
  targetParents: IssueParentInfo[]
): void {
  for (const pinfo of sourceParents) {
    res.push(
      control.txFactory.createTxUpdateDoc(tracker.class.Issue, pinfo.space, pinfo.parentId, {
        $pull: {
          childInfo: { childId: issue._id }
        }
      })
    )
  }
  for (const pinfo of targetParents) {
    res.push(
      control.txFactory.createTxUpdateDoc(tracker.class.Issue, pinfo.space, pinfo.parentId, {
        $push: {
          childInfo: {
            childId: issue._id,
            estimation: issue.estimation,
            reportedTime: issue.reportedTime
          }
        }
      })
    )
  }
}

async function issueLinkIdProvider (issue: Issue): Promise<string> {
  return issue.identifier
}

async function handleAutomaticDates (updateTx: TxUpdateDoc<Issue>, control: TriggerControl): Promise<Tx[]> {
  if (!Object.prototype.hasOwnProperty.call(updateTx.operations, 'status')) {
    return []
  }
  // Troca de tipo de projeto (status + kind no mesmo update): a tarefa já estava concluída,
  // só mudou de workflow. Carimbar completedDate aqui marcaria a data da MIGRAÇÃO.
  if (updateTx.operations.kind !== undefined) {
    return []
  }

  const newStatusId = updateTx.operations.status as Ref<IssueStatus>
  const [newStatus] = await control.findAll(control.ctx, tracker.class.IssueStatus, { _id: newStatusId }, { limit: 1 })
  if (newStatus === undefined || newStatus.category !== task.statusCategory.Won) {
    return []
  }

  const [issue] = await control.findAll(control.ctx, tracker.class.Issue, { _id: updateTx.objectId }, { limit: 1 })
  if (issue === undefined || (issue as any).completedDate != null) {
    return []
  }

  return [
    control.txFactory.createTxUpdateDoc(updateTx.objectClass, updateTx.objectSpace, updateTx.objectId, {
      completedDate: updateTx.modifiedOn as Timestamp
    })
  ]
}

/**
 * @public
 * Fills startDate on issue creation (fallback) and completedDate when status reaches Won category.
 */
export async function OnAutomaticDates (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []

  for (const tx of txes) {
    if (tx._class === core.class.TxCreateDoc) {
      const createTx = tx as TxCreateDoc<Issue>
      if (!control.hierarchy.isDerived(createTx.objectClass, tracker.class.Issue)) {
        continue
      }
      const issue = TxProcessor.createDoc2Doc(createTx)
      if ((issue as any).startDate == null) {
        result.push(
          control.txFactory.createTxUpdateDoc(createTx.objectClass, createTx.objectSpace, createTx.objectId, {
            startDate: createTx.modifiedOn as Timestamp
          })
        )
      }
    }

    if (tx._class === core.class.TxUpdateDoc) {
      const updateTx = tx as TxUpdateDoc<Issue>
      if (!control.hierarchy.isDerived(updateTx.objectClass, tracker.class.Issue)) {
        continue
      }
      result.push(...(await handleAutomaticDates(updateTx, control)))
    }
  }

  return result
}

/**
 * @public
 * Safety net: if a status is moved to Won without meeting completion rules,
 * revert to the previous status via a compensating transaction.
 * Primary validation happens in the frontend (StatusEditor.svelte).
 */
export async function OnIssueCompletionCheck (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []

  for (const tx of txes) {
    if (tx._class !== core.class.TxUpdateDoc) continue

    const updateTx = tx as TxUpdateDoc<Issue>
    if (!control.hierarchy.isDerived(updateTx.objectClass, tracker.class.Issue)) continue
    if (updateTx.operations.status === undefined) continue
    // Troca de tipo de projeto: o remapeamento grava `status` e `kind` no mesmo update.
    // Não é o usuário concluindo a tarefa — é o workflow inteiro sendo trocado —, então as
    // regras de conclusão não se aplicam. Revertê-las aqui devolveria a tarefa a um status
    // do tipo ANTIGO, que não existe mais no projeto, e ela sumiria das visões.
    if (updateTx.operations.kind !== undefined) continue

    const newStatusId = updateTx.operations.status as Ref<IssueStatus>

    // Fetch new status to check category (pre-tx state from DB)
    const [newStatus] = await control.findAll(
      control.ctx,
      tracker.class.IssueStatus,
      { _id: newStatusId },
      { limit: 1 }
    )
    if (!newStatus || newStatus.category !== task.statusCategory.Won) continue

    // Get current issue state (pre-tx: issue.status is still the OLD status)
    const [issue] = await control.findAll(
      control.ctx,
      tracker.class.Issue,
      { _id: updateTx.objectId },
      { limit: 1 }
    )
    if (!issue) continue

    const previousStatus = issue.status
    if (previousStatus === newStatusId) continue

    // Check project completion config
    const [project] = await control.findAll(
      control.ctx,
      tracker.class.Project,
      { _id: issue.space },
      { limit: 1 }
    )
    if (!project || !control.hierarchy.hasMixin(project, tracker.mixin.IssueCompletionConfig)) continue

    const config = control.hierarchy.as<Project, IssueCompletionConfig>(
      project,
      tracker.mixin.IssueCompletionConfig
    )
    const isSubIssue = (issue.parents?.length ?? 0) > 0
    const rules: CompletionRule[] = (isSubIssue ? config.subIssueRules : config.issueRules) ?? []

    let violated = false
    for (const rule of rules.filter((r) => r.enabled)) {
      if (rule.key === 'spentTime' && (!issue.reportedTime || issue.reportedTime <= 0)) {
        violated = true
        break
      }
      if (rule.key === 'estimation' && (!issue.estimation || issue.estimation <= 0)) {
        violated = true
        break
      }
      if (rule.key === 'allSubIssues' && (issue.subIssues as unknown as number) > 0) {
        const subIssues = await control.findAll(control.ctx, tracker.class.Issue, { attachedTo: issue._id })
        const subStatusIds = [...new Set(subIssues.map((s) => s.status))]
        const subStatuses = await control.findAll(control.ctx, tracker.class.IssueStatus, {
          _id: { $in: subStatusIds }
        })
        const statusMap = new Map(subStatuses.map((s) => [s._id, s]))
        const hasOpen = subIssues.some((s) => statusMap.get(s.status)?.category !== task.statusCategory.Won)
        if (hasOpen) { violated = true; break }
      }
      if (rule.key === 'completedDate' && !(issue as any).completedDate) {
        violated = true
        break
      }
    }

    if (violated) {
      result.push(
        control.txFactory.createTxUpdateDoc(
          updateTx.objectClass,
          updateTx.objectSpace,
          updateTx.objectId,
          { status: previousStatus }
        )
      )
    }
  }

  return result
}

interface TimeMachineMessage {
  type: 'schedule' | 'cancel'
  id: string
  targetDate?: number
  topic?: string
  data?: any
}

function calculateNextCycleDate (frequency: PdcaFrequency, from: number, customWeekdays?: number[]): number {
  const date = new Date(from)
  if (frequency === PdcaFrequency.Daily) {
    date.setDate(date.getDate() + 1)
    date.setHours(0, 0, 0, 0)
  } else if (frequency === PdcaFrequency.Weekly) {
    const daysUntilMonday = ((8 - date.getDay()) % 7) || 7
    date.setDate(date.getDate() + daysUntilMonday)
    date.setHours(0, 0, 0, 0)
  } else if (frequency === PdcaFrequency.Biweekly) {
    date.setDate(date.getDate() + 14)
    date.setHours(0, 0, 0, 0)
  } else if (frequency === PdcaFrequency.Quarterly) {
    date.setMonth(date.getMonth() + 3, 1)
    date.setHours(0, 0, 0, 0)
  } else if (frequency === PdcaFrequency.Custom) {
    if (customWeekdays != null && customWeekdays.length > 0) {
      const sorted = [...customWeekdays].sort((a, b) => a - b)
      const currentDow = date.getDay()
      const nextDow = sorted.find((d) => d > currentDow)
      const daysAhead = nextDow !== undefined ? nextDow - currentDow : 7 - currentDow + sorted[0]
      date.setDate(date.getDate() + daysAhead)
      date.setHours(0, 0, 0, 0)
    } else {
      date.setDate(date.getDate() + 7)
      date.setHours(0, 0, 0, 0)
    }
  } else {
    date.setMonth(date.getMonth() + 1, 1)
    date.setHours(0, 0, 0, 0)
  }
  return date.getTime()
}

async function schedulePdcaTimer (issue: Issue, control: TriggerControl): Promise<number | undefined> {
  if (control.queue == null) return
  const frequency = (issue as any).pdcaCycleFrequency as PdcaFrequency | undefined
  if (frequency == null) return
  const customWeekdays = (issue as any).pdcaCycleCustomWeekdays as number[] | undefined
  if (frequency === PdcaFrequency.Custom && (customWeekdays == null || customWeekdays.length === 0)) return
  const nextDate = calculateNextCycleDate(frequency, Date.now(), customWeekdays)
  const producer = control.queue.getProducer<TimeMachineMessage>(control.ctx, QueueTopic.TimeMachine)
  await producer.send(control.ctx, control.workspace.uuid, [{
    type: 'schedule',
    id: `pdca_${issue._id}`,
    targetDate: nextDate,
    topic: QueueTopic.PdcaCycle,
    data: { issueId: issue._id, workspaceId: control.workspace.uuid }
  }])
  return nextDate
}

async function cancelPdcaTimer (issueId: string, control: TriggerControl): Promise<void> {
  if (control.queue == null) return
  const producer = control.queue.getProducer<TimeMachineMessage>(control.ctx, QueueTopic.TimeMachine)
  await producer.send(control.ctx, control.workspace.uuid, [{
    type: 'cancel',
    id: `pdca_${issueId}`
  }])
}

/**
 * @public
 * Schedules or cancels the PDCA timer when pdcaCycleActive / pdcaCycleFrequency changes.
 */
export async function OnPdcaCycleToggle (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  for (const tx of txes) {
    if (tx._class === core.class.TxCreateDoc) {
      // Issues created already PDCA-active (automation scripts, templates, the
      // Create Issue dialog with PDCA enabled) never produced an update, so the
      // cycle was only scheduled on the next worker restart (bootstrap). Schedule
      // it here too. Idempotent with bootstrap: same TimeMachine id (pdca_<id>)
      // upserts, and bootstrap keeps any pdcaNextCycleDate we set.
      const createTx = tx as TxCreateDoc<Issue>
      if (!control.hierarchy.isDerived(createTx.objectClass, tracker.class.Issue)) continue
      if ((createTx.attributes as any).pdcaCycleActive !== true) continue

      const issue = TxProcessor.createDoc2Doc(createTx)
      const nextDate = await schedulePdcaTimer(issue, control)
      if (nextDate !== undefined) {
        result.push(control.txFactory.createTxUpdateDoc(
          createTx.objectClass,
          createTx.objectSpace,
          createTx.objectId,
          { pdcaNextCycleDate: nextDate }
        ))
      }
      continue
    }
    if (tx._class === core.class.TxUpdateDoc) {
      const updateTx = tx as TxUpdateDoc<Issue>
      if (!control.hierarchy.isDerived(updateTx.objectClass, tracker.class.Issue)) continue

      const ops = updateTx.operations as Record<string, unknown>
      const touchesCycle =
        Object.prototype.hasOwnProperty.call(ops, 'pdcaCycleActive') ||
        Object.prototype.hasOwnProperty.call(ops, 'pdcaCycleFrequency') ||
        Object.prototype.hasOwnProperty.call(ops, 'pdcaCycleResetStatus') ||
        Object.prototype.hasOwnProperty.call(ops, 'pdcaCycleCustomWeekdays')

      if (!touchesCycle) continue

      const [issue] = await control.findAll(control.ctx, tracker.class.Issue, { _id: updateTx.objectId }, { limit: 1 })
      if (issue === undefined) continue

      const isActive = (issue as any).pdcaCycleActive === true
      if (isActive) {
        const nextDate = await schedulePdcaTimer(issue, control)
        if (nextDate !== undefined) {
          result.push(control.txFactory.createTxUpdateDoc(
            updateTx.objectClass,
            updateTx.objectSpace,
            updateTx.objectId,
            { pdcaNextCycleDate: nextDate }
          ))
        }
      } else {
        await cancelPdcaTimer(String(issue._id), control)
        result.push(control.txFactory.createTxUpdateDoc(
          updateTx.objectClass,
          updateTx.objectSpace,
          updateTx.objectId,
          { pdcaNextCycleDate: undefined }
        ))
      }
    }
  }
  return result
}

async function doIssueClientPropagate (
  updateTx: TxUpdateDoc<Issue>,
  control: TriggerControl
): Promise<Tx[]> {
  const ops = updateTx.operations as Record<string, unknown>
  const hasClientName = Object.prototype.hasOwnProperty.call(ops, 'clientName')
  const hasClientStage = Object.prototype.hasOwnProperty.call(ops, 'clientStage')
  const hasClientCoreId = Object.prototype.hasOwnProperty.call(ops, 'clientCoreId')
  if (!hasClientName && !hasClientStage && !hasClientCoreId) return []

  const newClientName = hasClientName ? (ops.clientName as string) : undefined
  const newClientStage = hasClientStage ? (ops.clientStage as Issue['clientStage']) : undefined
  const newClientCoreId = hasClientCoreId ? (ops.clientCoreId as number | undefined) : undefined

  const descendants: Issue[] = []
  let frontier: Ref<Issue>[] = [updateTx.objectId]
  while (frontier.length > 0) {
    const children = await control.findAll(control.ctx, tracker.class.Issue, {
      attachedTo: { $in: frontier }
    })
    if (children.length === 0) break
    descendants.push(...children)
    frontier = children.map((c) => c._id)
  }

  const res: Tx[] = []
  for (const issue of descendants) {
    const update: DocumentUpdate<Issue> = {}
    if (hasClientName && (issue as any).clientName !== newClientName) {
      ;(update as any).clientName = newClientName
    }
    if (hasClientStage && (issue as any).clientStage !== newClientStage) {
      ;(update as any).clientStage = newClientStage
    }
    if (hasClientCoreId && newClientCoreId !== undefined && (issue as any).clientCoreId !== newClientCoreId) {
      ;(update as any).clientCoreId = newClientCoreId
    }
    if (Object.keys(update).length === 0) continue
    res.push(control.txFactory.createTxUpdateDoc(issue._class, issue.space, issue._id, update))
  }

  return res
}

async function doIssueReparentSync (
  updateTx: TxUpdateDoc<Issue>,
  control: TriggerControl
): Promise<Tx[]> {
  const newParentId = updateTx.operations.attachedTo as Ref<Issue> | undefined
  if (newParentId === undefined || newParentId === tracker.ids.NoParent) return []

  const [newParent] = await control.findAll(control.ctx, tracker.class.Issue, { _id: newParentId }, { limit: 1 })
  if (newParent === undefined) return []

  const [issue] = await control.findAll(control.ctx, tracker.class.Issue, { _id: updateTx.objectId }, { limit: 1 })
  if (issue === undefined) return []

  const parentName = (newParent as any).clientName ?? ''
  const parentStage = (newParent as any).clientStage ?? 'onboarding'
  const parentCoreId = (newParent as any).clientCoreId as number | undefined
  const update: DocumentUpdate<Issue> = {}
  if ((issue as any).clientName !== parentName) (update as any).clientName = parentName
  if ((issue as any).clientStage !== parentStage) (update as any).clientStage = parentStage
  if (parentCoreId !== undefined && (issue as any).clientCoreId !== parentCoreId) {
    ;(update as any).clientCoreId = parentCoreId
  }
  if (Object.keys(update).length === 0) return []

  return [control.txFactory.createTxUpdateDoc(updateTx.objectClass, updateTx.objectSpace, updateTx.objectId, update)]
}

async function doIssueCreateInherit (
  createTx: TxCreateDoc<Issue>,
  control: TriggerControl
): Promise<Tx[]> {
  const attrs = createTx.attributes as any
  const attachedTo = attrs.attachedTo as Ref<Issue> | undefined
  if (attachedTo === undefined || attachedTo === tracker.ids.NoParent) return []

  const [parent] = await control.findAll(control.ctx, tracker.class.Issue, { _id: attachedTo }, { limit: 1 })
  if (parent === undefined) return []

  const parentName = (parent as any).clientName ?? ''
  const parentStage = (parent as any).clientStage ?? 'onboarding'
  const parentCoreId = (parent as any).clientCoreId as number | undefined
  const childName = attrs.clientName ?? ''
  const childStage = attrs.clientStage ?? 'onboarding'
  const childCoreId = attrs.clientCoreId as number | undefined

  const update: DocumentUpdate<Issue> = {}
  if (childName !== parentName) (update as any).clientName = parentName
  if (childStage !== parentStage) (update as any).clientStage = parentStage
  if (parentCoreId !== undefined && childCoreId !== parentCoreId) {
    ;(update as any).clientCoreId = parentCoreId
  }
  if (Object.keys(update).length === 0) return []

  return [control.txFactory.createTxUpdateDoc(createTx.objectClass, createTx.objectSpace, createTx.objectId, update)]
}

/**
 * @public
 * Keeps sub-issues' clientName/clientStage/clientCoreId mirrored to their parent. Covers three paths:
 *   1) Parent updates clientName/clientStage → propagate to all descendants (BFS via attachedTo).
 *   2) Issue's attachedTo changes (re-parented) → pull values from the new parent.
 *   3) Issue is created with attachedTo pointing to another issue → pull values from the parent
 *      (covers scripts/API integrations that create sub-issues without setting client fields).
 */
export async function OnIssueClientPropagate (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  for (const tx of txes) {
    const objectClass = (tx as TxCUD<Issue>).objectClass
    if (objectClass === undefined) continue
    if (!control.hierarchy.isDerived(objectClass, tracker.class.Issue)) continue
    if (tx._class === core.class.TxCreateDoc) {
      result.push(...(await doIssueCreateInherit(tx as TxCreateDoc<Issue>, control)))
    } else if (tx._class === core.class.TxUpdateDoc) {
      const updateTx = tx as TxUpdateDoc<Issue>
      if (Object.prototype.hasOwnProperty.call(updateTx.operations, 'attachedTo')) {
        result.push(...(await doIssueReparentSync(updateTx, control)))
      }
      result.push(...(await doIssueClientPropagate(updateTx, control)))
    }
  }
  return result
}

/**
 * @public
 * Cancels the PDCA timer when a PDCA-active issue is deleted.
 */
export async function OnPdcaCycleCancel (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  for (const tx of txes) {
    if (tx._class === core.class.TxRemoveDoc) {
      const removeTx = tx as TxRemoveDoc<Issue>
      if (!control.hierarchy.isDerived(removeTx.objectClass, tracker.class.Issue)) continue
      const removed = control.removedMap.get(removeTx.objectId)
      if (removed == null || (removed as any).pdcaCycleActive !== true) continue
      await cancelPdcaTimer(String(removeTx.objectId), control)
    }
  }
  return []
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  function: {
    IssueHTMLPresenter: issueHTMLPresenter,
    IssueTextPresenter: issueTextPresenter,
    IssueNotificationContentProvider: getIssueNotificationContent,
    IssueLinkIdProvider: issueLinkIdProvider
  },
  trigger: {
    OnIssueUpdate,
    OnComponentRemove,
    OnProjectRemove,
    OnAutomaticDates,
    OnIssueCompletionCheck,
    OnIssueClientPropagate,
    OnPdcaCycleToggle,
    OnPdcaCycleCancel
  }
})
