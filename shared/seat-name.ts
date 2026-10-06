/**
 * Explicit seat names.
 *
 * A pane carries two different labels and they must not be confused:
 *   - `@operator_label` is the AUTO label: `<session>.<n>`, allocated in pane
 *     launch order by bin/tmux-label-pane.ts. It says nothing about the role of
 *     the seat in the pane.
 *   - `@peer_seat_name` is the EXPLICIT name: what `set_name`, a launcher's
 *     `-n`/`--seat-name`, or rename-lane chose for the seat on purpose.
 *
 * Fleets name control seats `<session>.<role number>`, which is exactly the
 * auto-label shape. When auto labels were the only durable pane state, an
 * explicit rename lasted until the next heartbeat or registration re-read the
 * pane and wrote the auto label back, and a seat could hold another seat's role
 * label for the whole session. The explicit name is therefore stored on the
 * pane (it lives exactly as long as the pane) and always outranks the auto label.
 */

export const SEAT_NAME_OPTION = "@peer_seat_name";

// Same bound the broker enforces for every peer name.
export const MAX_SEAT_NAME_BYTES = 128;

export function cleanSeatName(value: string | null | undefined): string | null {
  const trimmed = value?.replace(/\0/g, "").trim() ?? "";
  if (!trimmed) return null;
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return null;
  if (new TextEncoder().encode(trimmed).length > MAX_SEAT_NAME_BYTES) return null;
  return trimmed;
}

/** The name a pane's seat answers to: the explicit name when one was chosen. */
export function effectiveSeatName(seatName: string | null | undefined, autoLabel: string | null | undefined): string | null {
  return cleanSeatName(seatName) ?? cleanSeatName(autoLabel);
}

export const PANE_SEAT_FORMAT = [
  "#{pane_id}",
  "#{session_name}",
  "#{window_name}",
  `#{${SEAT_NAME_OPTION}}`,
  "#{@operator_label}",
  "#{pane_current_command}",
].join("\t");

export interface PaneSeatRow {
  paneId: string;
  session: string;
  windowName: string;
  seatName: string | null;
  operatorLabel: string | null;
  command: string;
}

export function parsePaneSeatRows(raw: string): PaneSeatRow[] {
  const rows: PaneSeatRow[] = [];
  for (const line of raw.split("\n")) {
    const [paneId = "", session = "", windowName = "", seatName = "", operatorLabel = "", command = ""] = line.split("\t");
    if (!/^%[0-9]+$/.test(paneId)) continue;
    rows.push({
      paneId,
      session,
      windowName,
      seatName: cleanSeatName(seatName),
      operatorLabel: cleanSeatName(operatorLabel),
      command: command.trim(),
    });
  }
  return rows;
}

const SHELL_COMMANDS = new Set(["bash", "zsh", "sh", "fish", "dash", "-bash", "-zsh", "-sh"]);

/**
 * Which other pane already answers to `name`?
 *
 * An explicit name always holds. An auto label holds only while an agent runs
 * in that pane: an idle shell's leftover label is not a live seat, but a live
 * agent that registered under the auto label is, and claiming its name would
 * hand the broker two seats with one operator name.
 */
export function seatNameHolder(rows: PaneSeatRow[], paneId: string, name: string): PaneSeatRow | null {
  for (const row of rows) {
    if (row.paneId === paneId) continue;
    if (row.seatName) {
      if (row.seatName === name) return row;
      continue;
    }
    if (row.operatorLabel === name && row.command && !SHELL_COMMANDS.has(row.command)) return row;
  }
  return null;
}

export function describeSeatHolder(row: PaneSeatRow): string {
  const how = row.seatName ? "explicit seat name" : "auto label of a running agent";
  return `pane ${row.paneId} (session "${row.session}", window "${row.windowName}", ${how})`;
}
