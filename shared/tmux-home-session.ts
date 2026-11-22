/**
 * A pane's "home" tmux session.
 *
 * A window can belong to several sessions at once: grouped sessions
 * (`new-session -t <target>`) share every window of the group, and
 * `link-window` puts one window into several sessions. Viewer tooling often
 * attaches through a throwaway grouped session with `destroy-unattached` set,
 * so the same pane is then reachable as both `work:1.2` and `viewer-7:1.2`.
 *
 * tmux itself does not pick a stable answer for such a pane:
 *   - `list-panes -a` lists the pane once per session, sorted by session
 *     name, so a last-wins parse lands on whichever name sorts last;
 *   - `display-message -t %N '#{session_name}'` resolves to the session
 *     tmux considers best for the window, usually the one a client is
 *     attached to, which is the viewer.
 *
 * Seat names, auto labels (`<session>.<n>`) and `session:window.pane`
 * targets must name the session the pane actually lives in. The rule, in
 * order:
 *   1. never a session with `destroy-unattached` set, while another candidate
 *      exists (a session that disappears on detach is a view, not a home);
 *   2. the session whose name equals its group name (tmux names a new group
 *      after the session it was created from, so that is the original);
 *   3. the oldest session (`session_created`, then the lower `$id`, which tmux
 *      allocates in creation order).
 * A pane in exactly one session is unaffected.
 */

/** Fields appended after `#{session_name}` to rank a pane's sessions. */
export const HOME_SESSION_FIELDS = [
  "#{session_id}",
  "#{session_grouped}",
  "#{session_group}",
  "#{session_created}",
  "#{destroy-unattached}",
].join("\t");

export const HOME_SESSION_FIELD_COUNT = 5;

/** `list-panes -a` format for {@link resolvePaneHomeSession}. */
export const PANE_HOME_SESSION_FORMAT = `#{pane_id}\t#{session_name}\t${HOME_SESSION_FIELDS}`;

export interface SessionCandidate {
  /** tmux session id, e.g. `$3`. Empty when unknown. */
  id: string;
  name: string;
  grouped: boolean;
  group: string;
  /** Unix seconds; NaN when unknown. */
  created: number;
  /** `destroy-unattached` is set to anything other than off. */
  viewer: boolean;
}

/**
 * Parse the {@link HOME_SESSION_FIELDS} values that follow a session name.
 * Returns null unless all five fields are present, so output from an older
 * format string never takes part in ranking.
 */
export function parseSessionCandidate(name: string, fields: readonly string[]): SessionCandidate | null {
  if (!name || fields.length < HOME_SESSION_FIELD_COUNT) return null;
  const [id = "", grouped = "", group = "", created = "", destroyUnattached = ""] = fields;
  const destroy = destroyUnattached.trim().toLowerCase();
  return {
    id: /^\$\d+$/.test(id) ? id : "",
    name,
    grouped: grouped === "1",
    group: grouped === "1" ? group : "",
    created: /^\d+$/.test(created) ? Number(created) : Number.NaN,
    viewer: destroy !== "" && destroy !== "off" && destroy !== "0",
  };
}

function sessionNumber(id: string): number {
  return id ? Number(id.slice(1)) : Number.POSITIVE_INFINITY;
}

/** Negative when `a` is the better home session, positive when `b` is. */
export function compareHomeSession(a: SessionCandidate, b: SessionCandidate): number {
  if (a.viewer !== b.viewer) return a.viewer ? 1 : -1;
  const aOriginal = a.grouped && a.name === a.group;
  const bOriginal = b.grouped && b.name === b.group;
  if (aOriginal !== bOriginal) return aOriginal ? -1 : 1;
  const aCreated = Number.isFinite(a.created) ? a.created : Number.POSITIVE_INFINITY;
  const bCreated = Number.isFinite(b.created) ? b.created : Number.POSITIVE_INFINITY;
  if (aCreated !== bCreated) return aCreated < bCreated ? -1 : 1;
  const aId = sessionNumber(a.id);
  const bId = sessionNumber(b.id);
  if (aId !== bId) return aId < bId ? -1 : 1;
  return 0;
}

export function chooseHomeSession(candidates: readonly SessionCandidate[]): SessionCandidate | null {
  let best: SessionCandidate | null = null;
  for (const candidate of candidates) {
    if (!best || compareHomeSession(candidate, best) < 0) best = candidate;
  }
  return best;
}

/**
 * Could `candidate` be a session other than the pane's home? False for an
 * ungrouped session and for a group's original, so the common case needs no
 * further tmux read.
 */
export function mayBeForeignSession(candidate: SessionCandidate | null): boolean {
  return candidate !== null && (candidate.viewer || (candidate.grouped && candidate.name !== candidate.group));
}

/**
 * The home session name for a pane whose session tmux reported as
 * `displayed` (from `display-message` with `#{session_name}` followed by
 * {@link HOME_SESSION_FIELDS}). Reads tmux again only when `displayed` may be
 * foreign; falls back to `displayed.name` when that read fails.
 */
export function homeSessionName(
  paneId: string,
  displayed: SessionCandidate,
  run: (args: string[]) => string | null,
): string {
  if (!mayBeForeignSession(displayed)) return displayed.name;
  return resolvePaneHomeSession(paneId, run)?.name ?? displayed.name;
}

/** Parse {@link PANE_HOME_SESSION_FORMAT} output into candidates per pane id. */
export function parsePaneHomeSessionRows(output: string): Map<string, SessionCandidate[]> {
  const byPane = new Map<string, SessionCandidate[]>();
  for (const line of output.split("\n")) {
    const [paneId = "", name = "", ...rest] = line.replace(/\r$/, "").split("\t");
    if (!/^%\d+$/.test(paneId)) continue;
    const candidate = parseSessionCandidate(name, rest);
    if (!candidate) continue;
    const list = byPane.get(paneId);
    if (list) list.push(candidate);
    else byPane.set(paneId, [candidate]);
  }
  return byPane;
}

/**
 * The home session of `paneId`, read live with one `list-panes -a`.
 * `run` returns the command's stdout, or null on failure. Returns null when
 * tmux cannot be read or the pane is not listed; callers then keep the
 * session they already had.
 */
export function resolvePaneHomeSession(
  paneId: string,
  run: (args: string[]) => string | null,
): SessionCandidate | null {
  if (!/^%\d+$/.test(paneId)) return null;
  const output = run(["list-panes", "-a", "-F", PANE_HOME_SESSION_FORMAT]);
  if (output === null) return null;
  return chooseHomeSession(parsePaneHomeSessionRows(output).get(paneId) ?? []);
}
