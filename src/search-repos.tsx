import { Action, ActionPanel, Cache, Icon, List, openExtensionPreferences } from "@raycast/api";
import { useMemo, useState } from "react";
import { RepoListItem } from "./components/RepoListItem";
import { useRepoIndex } from "./hooks/useRepoIndex";
import type { Filter } from "./lib/filters";
import { hostOf, matchesFilter, ownerOf } from "./lib/filters";
import type { SortOrder } from "./lib/sorting";
import { isSortOrder, SORT_ORDERS, sortEntries } from "./lib/sorting";
import type { RepoEntry } from "./lib/types";
import { pluralize } from "./lib/util";

const viewCache = new Cache();
const FILTER_KEY = "filter";
const SORT_KEY = "sort-order";
const SORT_PREFIX = "sort:";

function readSortOrder(): SortOrder {
  const stored = viewCache.get(SORT_KEY);
  return isSortOrder(stored) ? stored : "path";
}

/**
 * One dropdown for both filter and sort order, since the search bar takes a single accessory. It is
 * controlled by the filter: picking a sort item changes the order and leaves the shown filter as it was.
 */
function FilterDropdown({
  hosts,
  owners,
  filter,
  sortOrder,
  onFilterChange,
  onSortChange,
}: {
  hosts: string[];
  owners: string[];
  filter: Filter;
  sortOrder: SortOrder;
  onFilterChange: (filter: Filter) => void;
  onSortChange: (order: SortOrder) => void;
}) {
  return (
    <List.Dropdown
      tooltip="Filter and sort repositories"
      value={filter}
      onChange={(value) => {
        const order = value.startsWith(SORT_PREFIX) ? value.slice(SORT_PREFIX.length) : undefined;
        if (order === undefined) onFilterChange(value as Filter);
        else if (isSortOrder(order)) onSortChange(order);
      }}
    >
      <List.Dropdown.Section title="Status">
        <List.Dropdown.Item title="All Repositories" value="all" icon={Icon.Folder} />
        <List.Dropdown.Item title="Needs Attention" value="attention" icon={Icon.Warning} />
        <List.Dropdown.Item title="Remote Issues" value="remote-issues" icon={Icon.Globe} />
        <List.Dropdown.Item title="Uncommitted Changes" value="dirty" icon={Icon.Pencil} />
        <List.Dropdown.Item title="Ahead / Behind" value="unsynced" icon={Icon.ArrowClockwise} />
        <List.Dropdown.Item title="Forks" value="forks" icon={Icon.Duplicate} />
        <List.Dropdown.Item title="Forks Behind Upstream" value="fork-behind" icon={Icon.ArrowDown} />
        <List.Dropdown.Item title="Offloaded" value="offloaded" icon={Icon.Cloud} />
      </List.Dropdown.Section>
      <List.Dropdown.Section title="Sort Order">
        {SORT_ORDERS.map((order) => (
          <List.Dropdown.Item
            key={order.value}
            title={`Sort by ${order.title}`}
            value={`${SORT_PREFIX}${order.value}`}
            icon={order.value === sortOrder ? Icon.CheckCircle : Icon.Circle}
          />
        ))}
      </List.Dropdown.Section>
      <List.Dropdown.Section title="Hosts">
        {hosts.map((host) => (
          <List.Dropdown.Item key={host} title={host} value={`host:${host}`} icon={Icon.Globe} />
        ))}
      </List.Dropdown.Section>
      <List.Dropdown.Section title="Owners">
        {owners.map((owner) => (
          <List.Dropdown.Item key={owner} title={owner} value={`owner:${owner}`} icon={Icon.Person} />
        ))}
      </List.Dropdown.Section>
    </List.Dropdown>
  );
}

export default function Command() {
  const ctl = useRepoIndex();
  const [storedFilter, setStoredFilter] = useState<Filter>(() => (viewCache.get(FILTER_KEY) as Filter) ?? "all");
  const setFilter = (value: Filter) => {
    viewCache.set(FILTER_KEY, value);
    setStoredFilter(value);
  };
  const [showDetail, setShowDetail] = useState(false);
  const [sortOrder, setSortOrderState] = useState<SortOrder>(readSortOrder);
  const setSortOrder = (order: SortOrder) => {
    viewCache.set(SORT_KEY, order);
    setSortOrderState(order);
  };

  const entries = useMemo(() => ctl.index?.entries ?? [], [ctl.index]);
  const hosts = useMemo(() => [...new Set(entries.map(hostOf))].sort(), [entries]);
  const owners = useMemo(() => [...new Set(entries.map(ownerOf).filter(Boolean))].sort(), [entries]);
  // A controlled dropdown must contain its value: a remembered host or owner that is gone shows everything.
  const filter: Filter =
    (storedFilter.startsWith("host:") && !hosts.includes(storedFilter.slice("host:".length))) ||
    (storedFilter.startsWith("owner:") && !owners.includes(storedFilter.slice("owner:".length)))
      ? "all"
      : storedFilter;

  const sections = useMemo((): [string, RepoEntry[]][] => {
    const filtered = entries.filter((entry) => matchesFilter(entry, filter));
    if (sortOrder !== "path") {
      if (filtered.length === 0) return [];
      const title = SORT_ORDERS.find((order) => order.value === sortOrder)?.title;
      return [[`By ${title}`, sortEntries(filtered, sortOrder)]];
    }
    const byGroup = new Map<string, RepoEntry[]>();
    for (const entry of filtered) {
      const list = byGroup.get(entry.group) ?? [];
      list.push(entry);
      byGroup.set(entry.group, list);
    }
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [entries, filter, sortOrder]);

  return (
    <List
      isLoading={ctl.isLoading}
      isShowingDetail={showDetail}
      searchBarPlaceholder="Search repositories…"
      searchBarAccessory={
        <FilterDropdown
          hosts={hosts}
          owners={owners}
          filter={filter}
          sortOrder={sortOrder}
          onFilterChange={setFilter}
          onSortChange={setSortOrder}
        />
      }
    >
      {entries.length === 0 && ctl.scanError ? (
        <List.EmptyView
          icon={Icon.Warning}
          title="Could Not Scan Repositories"
          description={ctl.scanError}
          actions={
            <ActionPanel>
              <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
              <Action title="Try Again" icon={Icon.ArrowClockwise} onAction={() => ctl.refresh()} />
            </ActionPanel>
          }
        />
      ) : (
        <List.EmptyView
          icon={Icon.Folder}
          title={ctl.isLoading ? "Scanning…" : "No Repositories Found"}
          description={
            ctl.isLoading ? undefined : "Clone something with the “Clone Repository” command, or check the root folder."
          }
          actions={
            <ActionPanel>
              <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
            </ActionPanel>
          }
        />
      )}
      {sections.map(([group, groupEntries]) => (
        <List.Section key={group} title={group} subtitle={pluralize(groupEntries.length, "repo")}>
          {groupEntries.map((entry) => (
            <RepoListItem
              key={entry.relativePath}
              entry={entry}
              ctl={ctl}
              showDetail={showDetail}
              setShowDetail={setShowDetail}
              sortOrder={sortOrder}
              setSortOrder={setSortOrder}
            />
          ))}
        </List.Section>
      ))}
    </List>
  );
}
