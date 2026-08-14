export function cleanTmuxOptionValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

export function stripResolvedNameSuffix(label: string): string {
  return label.replace(/#[0-9]+$/, "");
}

// Window names a shell or tool sets on its own. These carry no operator intent, so
// they must never become a peer name — every lane would end up called "claude".
const GENERIC_WINDOW_NAMES = new Set([
  "bash", "zsh", "sh", "fish", "claude", "codex", "cursor", "cursor-agent", "agent",
  "kimi", "node", "npm", "npx", "bun", "tmux", "vim", "nvim", "nano", "less", "man", "ssh", "git",
]);

/**
 * Is this tmux window name something the OPERATOR chose?
 *
 * A window called REVIEW-1996 or MECH-DRAIN is a deliberate label and the best peer
 * name available — it is what the operator reads on screen and says out loud. A
 * window called "claude" or "3" is just what the shell left there.
 */
export function isOperatorChosenWindowName(name: string | undefined | null, session: string): boolean {
  const trimmed = name?.trim() ?? "";
  if (trimmed.length < 2) return false;
  if (/^[0-9]+$/.test(trimmed)) return false;
  // A pane id is metadata, never an operator's choice. `infra.%24` is the last-resort
  // machine label, and treating it as chosen would both preserve it as a name and let
  // it block the ordinal it was standing in for.
  if (trimmed.includes("%")) return false;
  if (trimmed.toLowerCase() === session.toLowerCase()) return false;
  // `<other-session>.<n>` is ANOTHER session's ordinal label, not a name chosen for
  // this one — accepting it would let a foreign label survive here as though the
  // operator had picked it. Only the ordinal shape is excluded, so REVIEW-1996 and
  // story-678 (hyphens, not dot-digits) still qualify.
  const foreignOrdinal = trimmed.match(/^(.+)\.(\d+)$/);
  if (foreignOrdinal && foreignOrdinal[1]!.toLowerCase() !== session.toLowerCase()) return false;
  return !GENERIC_WINDOW_NAMES.has(trimmed.toLowerCase());
}

export function isHumanOperatorLabel(label: string | null, session: string): label is string {
  if (!label) return false;
  const base = stripResolvedNameSuffix(label.trim());
  // The <session>.<n> ordinal form...
  if (base.startsWith(`${session}.`) && /^[0-9]+$/.test(base.slice(session.length + 1))) return true;
  // ...or a label the operator chose. Without this second arm, a lane named from its
  // window (REVIEW-1996) fails the check, gets treated as garbage, and is silently
  // re-derived back to an ordinal on the next registration — and it would not count
  // as "used", so a sibling could claim the same name.
  return isOperatorChosenWindowName(base, session);
}

export function chooseOperatorLabel(
  session: string,
  _paneIndex: string | undefined,
  usedLabels: Iterable<string>,
  windowName?: string | null,
  windowPanes?: number | null,
): string {
  const used = new Set<string>();
  let highestOrdinal = 0;
  for (const label of usedLabels) {
    const base = stripResolvedNameSuffix(label.trim());
    if (!base) continue;
    used.add(base);
    if (base.startsWith(`${session}.`)) {
      const suffix = base.slice(session.length + 1);
      const ordinal = /^[0-9]+$/.test(suffix) ? Number(suffix) : NaN;
      if (Number.isSafeInteger(ordinal) && ordinal > 0 && ordinal < Number.MAX_SAFE_INTEGER) {
        highestOrdinal = Math.max(highestOrdinal, ordinal);
      }
    }
  }

  // The operator's own window name wins when they chose one. It is the label on the
  // border, the thing they say out loud, and the thing already meaningful to them —
  // "REVIEW-1996" rather than "C5_lanes.7", which they would still have to map back
  // to a task. Falls through when the name is taken or generic.
  if (windowPanes === 1 && isOperatorChosenWindowName(windowName, session)) {
    const candidate = windowName!.trim();
    if (!used.has(candidate)) return candidate;
  }

  // Pane indexes are display positions: splitting or closing panes renumbers
  // them. Allocate after the highest live ordinal so layout rearrangement never
  // renames a surviving pane or fills a lower gap while higher labels are live.
  return `${session}.${highestOrdinal + 1}`;
}

export function preservedTmuxOperatorLabel(
  operatorLabel: string | null,
  peerLabel: string | null,
  session: string,
): string | null {
  // @operator_label is pane-scoped and explicitly sticky. Once present, keep it
  // even if it predates today's session.N shape; re-deriving a non-empty label
  // makes a surviving pane change identity when layouts or naming rules change.
  const explicit = cleanTmuxOptionValue(operatorLabel);
  if (explicit) return explicit;

  // @peer_label is broker-owned legacy state, so retain only a recognized human
  // label and remove the broker's numeric collision suffix before promoting it.
  const legacy = cleanTmuxOptionValue(peerLabel);
  return isHumanOperatorLabel(legacy, session)
    ? stripResolvedNameSuffix(legacy.trim())
    : null;
}
