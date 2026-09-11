//
// Copyright © 2022-2023 Hardcore Engineering Inc.
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

import { Employee, Person } from '@hcengineering/contact'
import {
  AttachedDoc,
  Attribute,
  Class,
  MarkupBlobRef,
  CollectionSize,
  Data,
  Doc,
  Markup,
  Mixin,
  Ref,
  RelatedDocument,
  Space,
  Status,
  Timestamp,
  Type,
  type Permission
} from '@hcengineering/core'
import { Asset, IntlString, Plugin, Resource, plugin } from '@hcengineering/platform'
import { Preference } from '@hcengineering/preference'
import { TagCategory, TagElement, TagReference } from '@hcengineering/tags'
import { ToDo } from '@hcengineering/time'
import {
  ProjectType,
  ProjectTypeDescriptor,
  Task,
  Project as TaskProject,
  TaskStatusFactory,
  TaskType,
  TaskTypeDescriptor
} from '@hcengineering/task'
import { AnyComponent, ComponentExtensionId, Location, ResolvedLocation } from '@hcengineering/ui'
import { Action, ActionCategory, IconProps } from '@hcengineering/view'

export * from './analytics'

/**
 * @public
 */
export enum PdcaFrequency {
  Daily = 'daily',
  Weekly = 'weekly',
  Biweekly = 'biweekly',
  Monthly = 'monthly',
  Quarterly = 'quarterly',
  Custom = 'custom'
}

/**
 * @public
 */
export enum ClientStage {
  Onboarding = 'onboarding',
  Expansion = 'expansion',
  Retention = 'retention',
  Churned = 'churned'
}

/**
 * @public
 */
export interface IssueStatus extends Status {}

/**
 * @public
 */
export interface Project extends TaskProject, IconProps {
  identifier: string // Project identifier
  sequence: number
  defaultIssueStatus?: Ref<IssueStatus>
  defaultAssignee?: Ref<Employee>
  defaultTimeReportDay: TimeReportDayType
  useClientName?: boolean
}

/**
 * @public
 */
export interface ProjectTargetPreference extends Preference {
  attachedTo: Ref<Project> // tracker.ids.ProjectPreferences

  usedOn: Timestamp

  props?: { key: string, value: any }[]
}

/**
 * @public
 */
export type CompletionRuleKey = 'spentTime' | 'estimation' | 'allSubIssues' | 'completedDate'

/**
 * @public
 */
export interface CompletionRule {
  key: CompletionRuleKey | string
  enabled: boolean
}

/**
 * @public
 * Mixin applied to Project to configure per-project issue completion requirements.
 */
export interface IssueCompletionConfig extends Project {
  issueRules: CompletionRule[]
  subIssueRules: CompletionRule[]
}

export type RelatedIssueKind = 'classRule' | 'spaceRule'

export interface RelatedClassRule {
  kind: 'classRule'
  ofClass: Ref<Class<Doc>>
}

export interface RelatedSpaceRule {
  kind: 'spaceRule'
  space: Ref<Space>
}

/**
 * @public
 *
 * If defined, will be used to set a default project for this kind of document's related issues.
 */
export interface RelatedIssueTarget extends Doc {
  // Attached to project.
  target?: Ref<Project> | null
  rule: RelatedClassRule | RelatedSpaceRule
}

/**
 * @public
 */
export enum TimeReportDayType {
  CurrentWorkDay = 'CurrentWorkDay',
  PreviousWorkDay = 'PreviousWorkDay'
}

/**
 * @public
 */
export enum IssuePriority {
  NoPriority,
  Urgent,
  High,
  Medium,
  Low
}

/**
 * @public
 */
export enum IssuesGrouping {
  Status = 'status',
  Assignee = 'assignee',
  Priority = 'priority',
  Component = 'component',
  Milestone = 'milestone',
  NoGrouping = '#no_category'
}

/**
 * @public
 */
export enum IssuesOrdering {
  Status = 'status',
  Priority = 'priority',
  LastUpdated = 'modifiedOn',
  DueDate = 'dueDate',
  Manual = 'rank'
}

/**
 * @public
 */
export enum IssuesDateModificationPeriod {
  All = 'all',
  PastWeek = 'pastWeek',
  PastMonth = 'pastMonth'
}


/**
 * @public
 */
export enum MilestoneStatus {
  Planned,
  InProgress,
  Completed,
  Canceled
}

/**
 * @public
 */
export interface Milestone extends Doc {
  label: string
  description?: Markup

  status: MilestoneStatus

  space: Ref<Project>

  comments: number
  attachments?: number

  targetDate: Timestamp
}

/**
 * @public
 */
export interface Issue extends Task {
  attachedTo: Ref<Issue>
  title: string
  description: MarkupBlobRef | null
  status: Ref<IssueStatus>
  priority: IssuePriority

  component: Ref<Component> | null

  // For subtasks
  subIssues: CollectionSize<Issue>
  blockedBy?: RelatedDocument[]
  relations?: RelatedDocument[]
  parents: IssueParentInfo[]

  space: Ref<Project>

  milestone?: Ref<Milestone> | null

  // Estimation in man hours
  estimation: number

  // Remaining time in man hours
  remainingTime: number

  // ReportedTime time, auto updated using trigger.
  reportedTime: number
  // Collection of reportedTime entries, for proper time estimations per person.
  reports: CollectionSize<TimeSpendReport>

  childInfo: IssueChildInfo[]

  startDate?: Timestamp | null
  completedDate?: Timestamp | null

  template?: {
    // A template issue is based on
    template: Ref<IssueTemplate>
    // Child id in template
    childId?: string
  }

  todos?: CollectionSize<ToDo>

  pdcaCycleActive?: boolean
  pdcaCycleFrequency?: PdcaFrequency
  pdcaCycleResetStatus?: Ref<IssueStatus>
  pdcaNextCycleDate?: Timestamp
  pdcaCycleDueDays?: number[]
  pdcaCycleCustomWeekdays?: number[]
  pdcaCycleDuplicate?: boolean
  pdcaCycleResetSubIssues?: boolean

  clientName: string
  clientStage: ClientStage
  // Ref to the client record in 3F Core (see F09 clientName via Core). When set, the
  // issue's client is "linked" to the canonical Core registry; when absent with a
  // non-empty clientName, the client is a legacy free-text value pending reconciliation.
  clientCoreId?: number
}

/**
 * @public
 */
export interface IssueDraft {
  kind: Ref<TaskType>
  _id: Ref<Issue>
  title: string
  description: Markup
  status?: Ref<IssueStatus>
  priority: IssuePriority
  assignee: Ref<Person>[] | null
  component: Ref<Component> | null
  space: Ref<Project>
  dueDate: Timestamp | null
  milestone?: Ref<Milestone> | null

  clientName: string
  clientStage: ClientStage
  clientCoreId?: number

  // Estimation in man days
  estimation: number
  parentIssue?: Ref<Issue>
  attachments?: number
  labels: TagReference[]
  subIssues: IssueDraft[]

  pdcaCycleActive?: boolean
  pdcaCycleFrequency?: PdcaFrequency
  pdcaCycleResetStatus?: Ref<IssueStatus>
  pdcaCycleDueDays?: number[]
  pdcaCycleCustomWeekdays?: number[]
  pdcaCycleDuplicate?: boolean
  pdcaCycleResetSubIssues?: boolean

  template?: {
    // A template issue is based on
    template: Ref<IssueTemplate>
    // Child id in template
    childId?: string
  }
}

/**
 * @public
 */
export interface IssueTemplateData {
  title: string
  description: Markup
  priority: IssuePriority

  assignee: Ref<Person>[] | null
  component: Ref<Component> | null

  milestone?: Ref<Milestone> | null

  // Estimation in man days
  estimation: number

  labels?: Ref<TagElement>[]

  kind?: Ref<TaskType>

  pdcaCycleActive?: boolean
  pdcaCycleFrequency?: PdcaFrequency
  pdcaCycleResetStatus?: Ref<IssueStatus>
  pdcaCycleDueDays?: number[]
  pdcaCycleCustomWeekdays?: number[]
  pdcaCycleDuplicate?: boolean
  pdcaCycleResetSubIssues?: boolean

  clientName?: string
  clientStage?: ClientStage
}

/**
 * @public
 */
export interface IssueTemplateChild extends IssueTemplateData {
  id: Ref<Issue>
}

/**
 * @public
 */
export interface IssueTemplate extends Doc, IssueTemplateData {
  space: Ref<Project>

  children: IssueTemplateChild[]

  // Discussion stuff
  comments: number
  attachments?: number

  relations?: RelatedDocument[]
}

/**
 * @public
 *
 * Declares time spend entry
 */
export interface TimeSpendReport extends AttachedDoc {
  attachedTo: Ref<Issue>

  employee: Ref<Employee> | null

  date: Timestamp | null
  // Value in man hours
  value: number

  description: string
}

/**
 * @public
 */
export interface IssueParentInfo {
  parentId: Ref<Issue>
  identifier: string
  parentTitle: string
  space: Ref<Space>
}

/**
 * @public
 */
export interface IssueChildInfo {
  childId: Ref<Issue>
  estimation: number
  reportedTime: number
}

/**
 * @public
 */
export interface Document extends Doc {
  title: string
  icon: string | null
  color: number
  content?: Markup

  space: Ref<Project>
}

/**
 * @public
 */
export interface Component extends Doc {
  label: string
  description?: Markup
  lead: Ref<Employee> | null
  space: Ref<Project>
  comments: number
  attachments?: number
}

/**
 * @public
 */
export interface AutomationVariantGroup {
  name: string
  options: string[]
}

/**
 * @public
 *
 * User-editable automation script (e.g. "Onboarding Seed"). Each script defines variant
 * groups; each group is a mutually-exclusive choice (radio) rendered in the runner wizard.
 * Steps opt-in to a specific value via requireAll against the active variant set.
 *
 * @deprecated variantOptions — old flat list. New scripts should use variantGroups.
 */
export interface AutomationScript extends Doc {
  name: string
  description?: string
  /** @deprecated kept for backwards-compat; migrated to variantGroups on load. */
  variantOptions?: string[]
  variantGroups?: AutomationVariantGroup[]
  steps: CollectionSize<AutomationScriptStep>
}

/**
 * @public
 *
 * One step of an AutomationScript: creates an Issue from a template inside a project.
 * Filtered at runtime: included iff (requireAll ⊆ active) && (requireNone ∩ active = ∅).
 */
export interface AutomationScriptStep extends AttachedDoc {
  attachedTo: Ref<AutomationScript>
  attachedToClass: Ref<Class<AutomationScript>>

  project: Ref<Project>
  template: Ref<IssueTemplate>
  order: number
  requireAll?: string[]
  requireNone?: string[]
  /** Dias a partir da execução do script para definir dueDate da issue raiz. */
  dueInDays?: number
  /** Mapeamento childId (IssueTemplateChild.id) → dias até vencimento da sub-issue. */
  childDueInDays?: Record<string, number>
}

/**
 * @public
 *
 * Snapshot de uma tarefa-raiz criada por uma execução de script. Guardado inline no
 * registro de execução para que o histórico sobreviva à exclusão/movimentação da issue.
 */
export interface ScriptExecutionTask {
  id: Ref<Issue>
  identifier: string
  title: string
  space: Ref<Project>
}

/**
 * @public
 *
 * Registro persistente de auditoria de uma execução de AutomationScript: quem rodou,
 * para qual cliente, quantas tarefas-raiz foram criadas e um snapshot delas. Criado uma
 * única vez ao final de RunAutomationScript.execute(); createdOn/createdBy carregam data/autor.
 */
export interface ScriptExecution extends Doc {
  script: Ref<AutomationScript>
  scriptName: string
  clientName: string
  executedBy: Ref<Person>
  taskCount: number
  tasks: ScriptExecutionTask[]
}

/**
 * @public
 */
export const trackerId = 'tracker' as Plugin
export * from './analytics'

const pluginState = plugin(trackerId, {
  class: {
    Project: '' as Ref<Class<Project>>,
    Issue: '' as Ref<Class<Issue>>,
    IssueTemplate: '' as Ref<Class<IssueTemplate>>,
    Component: '' as Ref<Class<Component>>,
    IssueStatus: '' as Ref<Class<IssueStatus>>,
    TypeIssuePriority: '' as Ref<Class<Type<IssuePriority>>>,
    Milestone: '' as Ref<Class<Milestone>>,
    TypeMilestoneStatus: '' as Ref<Class<Type<MilestoneStatus>>>,
    TimeSpendReport: '' as Ref<Class<TimeSpendReport>>,
    TypeReportedTime: '' as Ref<Class<Type<number>>>,
    TypeEstimation: '' as Ref<Class<Type<number>>>,
    TypeRemainingTime: '' as Ref<Class<Type<number>>>,
    RelatedIssueTarget: '' as Ref<Class<RelatedIssueTarget>>,
    ProjectTargetPreference: '' as Ref<Class<ProjectTargetPreference>>,
    AutomationScript: '' as Ref<Class<AutomationScript>>,
    AutomationScriptStep: '' as Ref<Class<AutomationScriptStep>>,
    ScriptExecution: '' as Ref<Class<ScriptExecution>>
  },
  mixin: {
    ClassicProjectTypeData: '' as Ref<Mixin<Project>>,
    IssueTypeData: '' as Ref<Mixin<Issue>>,
    IssueCompletionConfig: '' as Ref<Mixin<Project>>
  },
  ids: {
    NoParent: '' as Ref<Issue>,
    IssueDraft: '',
    IssueDraftChild: '',
    ClassingProjectType: '' as Ref<ProjectType>
  },
  status: {
    Backlog: '' as Ref<Status>,
    Todo: '' as Ref<Status>,
    InProgress: '' as Ref<Status>,
    Coding: '' as Ref<Status>,
    UnderReview: '' as Ref<Status>,
    Done: '' as Ref<Status>,
    Canceled: '' as Ref<Status>
  },
  component: {
    Tracker: '' as AnyComponent,
    TrackerApp: '' as AnyComponent,
    RelatedIssues: '' as AnyComponent,
    RelatedIssuesSection: '' as AnyComponent,
    RelatedIssueSelector: '' as AnyComponent,
    RelatedIssueTemplates: '' as AnyComponent,
    EditIssue: '' as AnyComponent,
    CreateIssue: '' as AnyComponent,
    ProjectPresenter: '' as AnyComponent,
    CreateIssueTemplate: '' as AnyComponent,
    CreateProject: '' as AnyComponent,
    IssueStatusPresenter: '' as AnyComponent,
    LabelsView: '' as AnyComponent
  },
  attribute: {
    IssueStatus: '' as Ref<Attribute<Status>>
  },
  icon: {
    TrackerApplication: '' as Asset,
    Component: '' as Asset,
    Issue: '' as Asset,
    Subissue: '' as Asset,
    Project: '' as Asset,
    Relations: '' as Asset,
    Inbox: '' as Asset,
    MyIssues: '' as Asset,
    Views: '' as Asset,
    Issues: '' as Asset,
    Components: '' as Asset,
    NewIssue: '' as Asset,
    Magnifier: '' as Asset,
    Labels: '' as Asset,
    DueDate: '' as Asset,
    Parent: '' as Asset,
    UnsetParent: '' as Asset,
    Milestone: '' as Asset,
    IssueTemplates: '' as Asset,
    Start: '' as Asset,
    Stop: '' as Asset,

    CategoryBacklog: '' as Asset,
    CategoryUnstarted: '' as Asset,
    CategoryStarted: '' as Asset,
    CategoryCompleted: '' as Asset,
    CategoryCanceled: '' as Asset,

    PriorityNoPriority: '' as Asset,
    PriorityUrgent: '' as Asset,
    PriorityHigh: '' as Asset,
    PriorityMedium: '' as Asset,
    PriorityLow: '' as Asset,

    ComponentsList: '' as Asset,

    MilestoneStatusPlanned: '' as Asset,
    MilestoneStatusInProgress: '' as Asset,
    MilestoneStatusPaused: '' as Asset,
    MilestoneStatusCompleted: '' as Asset,
    MilestoneStatusCanceled: '' as Asset,

    CopyBranch: '' as Asset,
    Duplicate: '' as Asset,

    TimeReport: '' as Asset,
    Estimation: '' as Asset,

    // Project icons
    Home: '' as Asset,
    RedCircle: '' as Asset
  },
  category: {
    Other: '' as Ref<TagCategory>,
    Tracker: '' as Ref<ActionCategory>
  },
  descriptors: {
    ProjectType: '' as Ref<ProjectTypeDescriptor>,
    Issue: '' as Ref<TaskTypeDescriptor>
  },
  action: {
    CopyAsMarkdownTable: '' as Ref<Action<Doc, any>>,
    SetDueDate: '' as Ref<Action<Doc, any>>,
    SetParent: '' as Ref<Action<Doc, any>>,
    SetStatus: '' as Ref<Action>,
    SetPriority: '' as Ref<Action<Doc, any>>,
    SetAssignee: '' as Ref<Action<Doc, any>>,
    SetComponent: '' as Ref<Action<Doc, any>>,
    CopyIssueId: '' as Ref<Action<Doc, any>>,
    CopyIssueTitle: '' as Ref<Action<Doc, any>>,
    CopyIssueLink: '' as Ref<Action<Doc, any>>,
    MoveToProject: '' as Ref<Action>,
    Duplicate: '' as Ref<Action<Doc, any>>,
    Relations: '' as Ref<Action<Doc, any>>,
    NewIssue: '' as Ref<Action<Doc, any>>,
    NewIssueGlobal: '' as Ref<Action<Doc, any>>,
    NewSubIssue: '' as Ref<Action<Doc, any>>,
    EditWorkflowStatuses: '' as Ref<Action>,
    EditProject: '' as Ref<Action>,
    SetMilestone: '' as Ref<Action<Doc, any>>,
    SetLabels: '' as Ref<Action<Doc, any>>,
    EditRelatedTargets: '' as Ref<Action<Doc, any>>,
    UnsetParent: '' as Ref<Action<Doc, any>>
  },
  project: {
    DefaultProject: '' as Ref<Project>
  },
  resolver: {
    Location: '' as Resource<(loc: Location) => Promise<ResolvedLocation | undefined>>
  },
  string: {
    TrackerApplication: '' as IntlString,
    ConfigLabel: '' as IntlString,
    NewRelatedIssue: '' as IntlString,
    IssueNotificationTitle: '' as IntlString,
    IssueNotificationBody: '' as IntlString,
    IssueNotificationChanged: '' as IntlString,
    IssueNotificationChangedProperty: '' as IntlString,
    IssueNotificationMessage: '' as IntlString,
    IssueAssignedToYou: '' as IntlString,
    Project: '' as IntlString,
    RelatedIssues: '' as IntlString,
    Issue: '' as IntlString,
    NewProject: '' as IntlString,
    ChangeProjectType: '' as IntlString,
    ChangeProjectTypeConfirmButton: '' as IntlString,
    ChangeProjectTypeIntro: '' as IntlString,
    ChangeProjectTypeNoTasks: '' as IntlString,
    ChangeProjectTypeFrom: '' as IntlString,
    ChangeProjectTypeTo: '' as IntlString,
    ChangeProjectTypeTaskCount: '' as IntlString,
    ChangeProjectTypeRolesWarning: '' as IntlString,
    ChangeProjectTypeProgress: '' as IntlString,
    ChangeProjectTypeRoleTask: '' as IntlString,
    ChangeProjectTypeRoleSubTask: '' as IntlString,
    ChangeProjectTypeRoleBoth: '' as IntlString,
    ChangeProjectTypeRoleMismatch: '' as IntlString,
    ChangeProjectTypeEstimate: '' as IntlString,
    UnsetParentIssue: '' as IntlString,
    ForbidCreateProjectPermission: '' as IntlString,
    ForbidCreateProjectPermissionDescription: '' as IntlString,
    AllProjects: '' as IntlString,
    CompletionRules: '' as IntlString,
    SubIssueCompletionRules: '' as IntlString,
    CompletionBlocked: '' as IntlString,
    CompletionBlockedTask: '' as IntlString,
    CompletionBlockedSubtask: '' as IntlString,
    CompletionRuleSpentTime: '' as IntlString,
    CompletionRuleEstimation: '' as IntlString,
    CompletionRuleAllSubIssues: '' as IntlString,
    CompletionRuleCompletedDate: '' as IntlString,
    ConfigureCompletionRules: '' as IntlString,
    MissingSpentTime: '' as IntlString,
    MissingEstimation: '' as IntlString,
    OpenSubtasksBlocking: '' as IntlString,
    MissingCompletedDate: '' as IntlString,
    ClientName: '' as IntlString,
    ClientStage: '' as IntlString,
    ClientCoreId: '' as IntlString,
    ClientsMigration: '' as IntlString,
    EmployeeOffboarding: '' as IntlString,
    SelectEmployee: '' as IntlString,
    UseClientName: '' as IntlString,
    PdcaDueWeekday: '' as IntlString,
    PdcaDueMonthDay: '' as IntlString,
    PdcaDueMonthDays: '' as IntlString,
    PdcaDuplicate: '' as IntlString,
    PdcaResetSubIssues: '' as IntlString,
    PdcaWeekdayMon: '' as IntlString,
    PdcaWeekdayTue: '' as IntlString,
    PdcaWeekdayWed: '' as IntlString,
    PdcaWeekdayThu: '' as IntlString,
    PdcaWeekdayFri: '' as IntlString,
    PdcaWeekdaySat: '' as IntlString,
    PdcaWeekdaySun: '' as IntlString
  },
  extensions: {
    IssueListHeader: '' as ComponentExtensionId,
    EditIssueHeader: '' as ComponentExtensionId,
    EditIssueTitle: '' as ComponentExtensionId
  },
  taskTypes: {
    Issue: '' as Ref<TaskType>,
    SubIssue: '' as Ref<TaskType>
  },
  permission: {
    ForbidCreateProject: '' as Ref<Permission>
  }
})
export default pluginState

/**
 * @public
 */
export function createStatesData (data: TaskStatusFactory[]): Omit<Data<Status>, 'rank'>[] {
  const states: Omit<Data<Status>, 'rank'>[] = []

  for (const category of data) {
    for (const sName of category.statuses) {
      states.push({
        ofAttribute: pluginState.attribute.IssueStatus,
        name: Array.isArray(sName) ? sName[0] : sName,
        color: Array.isArray(sName) ? sName[1] : undefined,
        category: category.category
      })
    }
  }
  return states
}
