import { clampDashboard, dashboardListViewport } from "./dashboard-style.ts";

export interface DashboardCollectionGroupDefinition<Group extends string> {
  key: Group;
  label: string;
  /** Rows in this group yield first when the list does not fit. */
  foldLabel?: string;
}

export interface DashboardCollectionGroup<Item, Group extends string>
  extends DashboardCollectionGroupDefinition<Group> {
  items: readonly Item[];
}

export interface DashboardCollection<Item, Group extends string> {
  groups: readonly DashboardCollectionGroup<Item, Group>[];
  /** Entity-only attention order used by keyboard navigation. */
  items: readonly Item[];
}

export type DashboardCollectionRow<Item, Group extends string> =
  | { kind: "section"; group: Group; label: string; count: number }
  | { kind: "item"; group: Group; item: Item }
  | { kind: "fold"; group: Group; label: string; hidden: number };

export interface DashboardCollectionViewport<Item, Group extends string> {
  rows: readonly DashboardCollectionRow<Item, Group>[];
  items: readonly Item[];
  clippedBefore: boolean;
  clippedAfter: boolean;
  folded: number;
}

/** Stable partition into explicit attention groups. */
export function groupDashboardCollection<Item, Group extends string>(
  items: readonly Item[],
  definitions: readonly DashboardCollectionGroupDefinition<Group>[],
  groupFor: (item: Item) => Group,
): DashboardCollection<Item, Group> {
  const buckets = definitions.map((definition) => ({ definition, items: [] as Item[] }));
  for (const item of items) {
    const key = groupFor(item);
    const bucket = buckets.find((candidate) => candidate.definition.key === key);
    if (!bucket) throw new Error(`Missing dashboard collection group: ${key}`);
    bucket.items.push(item);
  }
  const groups = buckets
    .filter((bucket) => bucket.items.length > 0)
    .map(({ definition, items }): DashboardCollectionGroup<Item, Group> => ({
      ...definition,
      items,
    }));

  return {
    groups,
    items: groups.flatMap((group) => group.items),
  };
}

/**
 * Inserts presentation-only section rows and folds low-priority groups before
 * taking a selection-centered viewport. The selected entity is always present
 * in the logical rows, including when it belongs to a folded group.
 */
export function dashboardCollectionViewport<Item, Group extends string, Id>(
  collection: DashboardCollection<Item, Group>,
  selectedId: Id | undefined,
  rows: number,
  idFor: (item: Item) => Id,
): DashboardCollectionViewport<Item, Group> {
  const rowBudget = Math.max(0, Math.floor(rows));
  const fullSize = collection.groups.reduce((total, group) => total + group.items.length + 1, 0);
  const pressure = fullSize > rowBudget;
  const logical: Array<DashboardCollectionRow<Item, Group>> = [];
  let folded = 0;

  for (const group of collection.groups) {
    if (!pressure || !group.foldLabel) {
      logical.push(sectionRow(group));
      logical.push(...group.items.map((item): DashboardCollectionRow<Item, Group> => ({
        kind: "item",
        group: group.key,
        item,
      })));
      continue;
    }

    const room = Math.max(0, rowBudget - logical.length);
    const selectedIndex = selectedId === undefined
      ? -1
      : group.items.findIndex((item) => idFor(item) === selectedId);
    const selected = selectedIndex >= 0;
    const visibleSlots = Math.max(1, room - 2);
    const visible = selected
      ? selectedWindow(group.items, selectedIndex, visibleSlots)
      : group.items.slice(0, Math.max(0, room - 2));
    const hidden = group.items.length - visible.length;

    if (hidden <= 0) {
      logical.push(sectionRow(group));
      logical.push(...visible.map((item): DashboardCollectionRow<Item, Group> => ({
        kind: "item",
        group: group.key,
        item,
      })));
      continue;
    }

    folded += hidden;
    if (room >= 3) logical.push(sectionRow(group));
    logical.push(...visible.map((item): DashboardCollectionRow<Item, Group> => ({
      kind: "item",
      group: group.key,
      item,
    })));
    logical.push({
      kind: "fold",
      group: group.key,
      label: group.foldLabel,
      hidden,
    });
  }

  const selectedRow = selectedId === undefined
    ? logical.findIndex((row) => row.kind === "item")
    : logical.findIndex((row) => row.kind === "item" && idFor(row.item) === selectedId);
  const view = dashboardListViewport(logical, Math.max(0, selectedRow), rowBudget);
  const visibleRows = [...view.items];
  let foldRow: DashboardCollectionRow<Item, Group> | undefined;
  for (let index = logical.length - 1; index >= 0; index--) {
    if (logical[index]?.kind === "fold") {
      foldRow = logical[index];
      break;
    }
  }
  if (foldRow && rowBudget >= 2 && !visibleRows.some((row) => row.kind === "fold")) {
    let replaceSection = -1;
    let replaceOther = -1;
    for (let index = visibleRows.length - 1; index >= 0; index--) {
      const row = visibleRows[index];
      if (!row) continue;
      if (replaceSection < 0 && row.kind === "section") replaceSection = index;
      if (replaceOther < 0 && (row.kind !== "item" || selectedId === undefined || idFor(row.item) !== selectedId)) {
        replaceOther = index;
      }
    }
    const replaceAt = replaceSection >= 0 ? replaceSection : replaceOther;
    if (replaceAt >= 0) visibleRows[replaceAt] = foldRow;
  }

  return {
    rows: visibleRows,
    items: collection.items,
    clippedBefore: view.start > 0,
    clippedAfter: view.end < logical.length,
    folded,
  };
}

function sectionRow<Item, Group extends string>(
  group: DashboardCollectionGroup<Item, Group>,
): DashboardCollectionRow<Item, Group> {
  return {
    kind: "section",
    group: group.key,
    label: group.label,
    count: group.items.length,
  };
}

function selectedWindow<Item>(items: readonly Item[], selected: number, size: number): readonly Item[] {
  const boundedSize = Math.max(1, Math.min(size, items.length));
  const start = clampDashboard(
    selected - Math.floor(boundedSize / 2),
    0,
    Math.max(0, items.length - boundedSize),
  );
  return items.slice(start, start + boundedSize);
}
