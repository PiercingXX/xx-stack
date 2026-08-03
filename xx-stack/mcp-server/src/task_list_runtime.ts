/**
 * Task-list filtering shared by the `task_list` MCP tool and `xx tasks list`
 * (MCP-DUP-3).
 *
 * The two used to be independent copies of the same status/tag/owner filters,
 * localeCompare sort, and `slice(0, limit ?? 100)` cap, with tests on the CLI
 * copy only. Both sides now call this function, so the shaping cannot be
 * changed on one side alone.
 */

import {
  TASK_TERMINAL_STATUSES,
  type PersistentTask,
  type TaskStatus,
  type TaskStore,
} from "./task_runtime.js";

export interface TaskListFilters {
  status?: TaskStatus;
  tag?: string;
  owner?: string;
  includeCompleted?: boolean;
  limit?: number;
}

export interface TaskListResult {
  total: number;
  returned: number;
  tasks: PersistentTask[];
}

/**
 * Filter and sort the task store: status/tag/owner filters, terminal statuses
 * hidden unless includeCompleted, newest-updated first, default cap 100.
 * `total` counts every match; `returned` counts what survived the cap.
 */
export function filterTasks(store: TaskStore, filters: TaskListFilters): TaskListResult {
  const tagFilter = filters.tag?.trim().toLowerCase();
  const ownerFilter = filters.owner?.trim().toLowerCase();

  const tasks = Object.values(store.tasks)
    .filter((task) => !filters.status || task.status === filters.status)
    .filter((task) => filters.includeCompleted === true || !TASK_TERMINAL_STATUSES.has(task.status))
    .filter(
      (task) => !tagFilter || task.tags.some((taskTag) => taskTag.toLowerCase() === tagFilter)
    )
    .filter((task) => !ownerFilter || (task.owner ?? "").toLowerCase() === ownerFilter)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  const capped = tasks.slice(0, filters.limit ?? 100);
  return { total: tasks.length, returned: capped.length, tasks: capped };
}
