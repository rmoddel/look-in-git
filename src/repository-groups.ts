import type { Repository } from '../shared/types';

export const ALL_GROUPS = 'all';
export const UNGROUPED = 'ungrouped';
export interface RepositoryGroup { id: string; name: string }
export interface RepositoryGroups {
  groups: RepositoryGroup[];
  assignments: Record<string, string>;
  activeGroup: string;
}

// Repository IDs change on server restart. Labels follow the canonical local
// path instead, treating Windows separators/casing as the same location.
export function repositoryKey(root: string) {
  const normalized = root.replaceAll('\\', '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function groupName(value: string) {
  const name = value.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 48 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Use a group name of 1–48 characters.');
  if (['all groups', 'ungrouped'].includes(name.toLowerCase())) throw new Error('Choose a custom name; All groups and Ungrouped are built-in views.');
  return name;
}

export function readGroups(value: unknown): RepositoryGroups {
  const empty: RepositoryGroups = { groups: [], assignments: {}, activeGroup: ALL_GROUPS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;
  const input = value as Partial<RepositoryGroups>;
  if (Array.isArray(input.groups)) for (const group of input.groups.slice(0, 200)) {
    if (!group || typeof group.id !== 'string' || !/^group-[a-z0-9-]{1,64}$/i.test(group.id) || typeof group.name !== 'string') continue;
    try {
      const name = groupName(group.name);
      if (!empty.groups.some(item => item.id === group.id || item.name.toLowerCase() === name.toLowerCase())) empty.groups.push({ id: group.id, name });
    } catch { /* Ignore malformed saved preferences. */ }
  }
  if (input.assignments && typeof input.assignments === 'object' && !Array.isArray(input.assignments)) {
    for (const [root, id] of Object.entries(input.assignments).slice(0, 2000)) {
      if ((/^[a-z]:[\\/]/i.test(root) || root.startsWith('/')) && empty.groups.some(group => group.id === id)) empty.assignments[repositoryKey(root)] = id;
    }
  }
  if (input.activeGroup === UNGROUPED || empty.groups.some(group => group.id === input.activeGroup)) empty.activeGroup = input.activeGroup!;
  return empty;
}

export function repositoryGroup(state: RepositoryGroups, root: string) {
  const id = state.assignments[repositoryKey(root)];
  return state.groups.some(group => group.id === id) ? id : UNGROUPED;
}
export function groupLabel(state: RepositoryGroups, id = state.activeGroup) {
  return id === ALL_GROUPS ? 'All groups' : state.groups.find(group => group.id === id)?.name ?? 'Ungrouped';
}
export function groupedRepositories(repositories: Repository[], state: RepositoryGroups, id = state.activeGroup) {
  return id === ALL_GROUPS ? repositories : repositories.filter(repo => repositoryGroup(state, repo.root) === id);
}
export function createGroup(state: RepositoryGroups, value: string, id: string): RepositoryGroups {
  const name = groupName(value);
  if (state.groups.some(group => group.name.toLowerCase() === name.toLowerCase())) throw new Error('A group with that name already exists.');
  if (state.groups.length >= 200) throw new Error('Up to 200 groups can be saved.');
  return { ...state, groups: [...state.groups, { id, name }] };
}
export function renameGroup(state: RepositoryGroups, id: string, value: string): RepositoryGroups {
  const name = groupName(value);
  if (state.groups.some(group => group.id !== id && group.name.toLowerCase() === name.toLowerCase())) throw new Error('A group with that name already exists.');
  return { ...state, groups: state.groups.map(group => group.id === id ? { ...group, name } : group) };
}
export function removeGroup(state: RepositoryGroups, id: string): RepositoryGroups {
  return { groups: state.groups.filter(group => group.id !== id), assignments: Object.fromEntries(Object.entries(state.assignments).filter(([, group]) => group !== id)), activeGroup: state.activeGroup === id ? ALL_GROUPS : state.activeGroup };
}
export function assignGroup(state: RepositoryGroups, root: string, id: string): RepositoryGroups {
  const assignments = { ...state.assignments };
  const key = repositoryKey(root);
  if (state.groups.some(group => group.id === id)) assignments[key] = id;
  else delete assignments[key];
  return { ...state, assignments };
}
