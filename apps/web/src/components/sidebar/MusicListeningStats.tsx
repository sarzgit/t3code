import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  formatMusicDuration,
  MUSIC_HISTORY_CHUNK_ROWS,
  parseMusicHistoryCsv,
} from "@t3tools/client-runtime/state/music";
import type { EnvironmentId, MusicStats, MusicStatsInput, ProjectId } from "@t3tools/contracts";
import { EllipsisIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useProject } from "~/state/entities";
import { musicEnvironment } from "~/state/music";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const STATS_RANGES: ReadonlyArray<{ days: MusicStatsInput["days"]; label: string }> = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
];

// A multi-year export is a few MB; this only stops a wrong pick from freezing the tab.
const MAX_HISTORY_FILE_BYTES = 200 * 1024 * 1024;

const formatDay = (day: string) =>
  new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

type ImportStatus =
  | { readonly _tag: "idle" }
  | { readonly _tag: "importing"; readonly percent: number }
  | { readonly _tag: "failed"; readonly message: string };

export function ListeningStats({ environmentId }: { environmentId: EnvironmentId }) {
  const [days, setDays] = useState<MusicStatsInput["days"]>(7);
  const query = useEnvironmentQuery(musicEnvironment.stats({ environmentId, input: { days } }));
  const [importStatus, setImportStatus] = useState<ImportStatus>({ _tag: "idle" });
  const stats = query.data;
  return (
    <div className="flex flex-col gap-3">
      <ToggleGroup
        aria-label="Stats range"
        className="w-full *:flex-1"
        variant="segmented"
        value={[String(days)]}
        onValueChange={(next) => {
          const range = STATS_RANGES.find((option) => String(option.days) === next[0]);
          if (range) setDays(range.days);
        }}
      >
        {STATS_RANGES.map((range) => (
          <Toggle key={range.days} value={String(range.days)}>
            {range.label}
          </Toggle>
        ))}
      </ToggleGroup>
      {stats === null ? (
        query.error ? (
          <div className="flex items-center justify-between gap-2 py-1 text-xs text-muted-foreground">
            <span>{query.error}</span>
            <Button variant="outline" size="xs" onClick={query.refresh}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="flex justify-center py-3">
            <Spinner />
          </div>
        )
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            {stats.totalSec < 60 ? (
              <p className="text-sm text-muted-foreground">No listening yet</p>
            ) : (
              <p className="text-2xl font-semibold tabular-nums">
                {formatMusicDuration(stats.totalSec)}
              </p>
            )}
            <HistoryMenu
              environmentId={environmentId}
              importedThrough={stats.importedThrough ?? null}
              importing={importStatus._tag === "importing"}
              onStatus={setImportStatus}
              onChange={query.refresh}
            />
          </div>
          {importStatus._tag === "importing" ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner size="xs" />
              Importing {Math.min(importStatus.percent, 100)}%
            </p>
          ) : importStatus._tag === "failed" ? (
            <p role="alert" className="text-xs text-destructive">
              {importStatus.message}
            </p>
          ) : null}
          <ProjectStats environmentId={environmentId} stats={stats} />
        </>
      )}
    </div>
  );
}

/** Imports Apple's play history export, or removes it. Listening from it counts toward totals. */
function HistoryMenu(props: {
  environmentId: EnvironmentId;
  importedThrough: string | null;
  importing: boolean;
  onStatus: (status: ImportStatus) => void;
  onChange: () => void;
}) {
  const { environmentId, onStatus } = props;
  const canImport = useAtomValue(musicEnvironment.importHistory.permissionAtom(environmentId));
  const importHistory = useAtomCommand(musicEnvironment.importHistory);
  const clearHistory = useAtomCommand(musicEnvironment.clearHistory);
  const fileInput = useRef<HTMLInputElement>(null);

  const importFile = async (file: File) => {
    if (file.size > MAX_HISTORY_FILE_BYTES) {
      onStatus({ _tag: "failed", message: "That file is too large to be the play history." });
      return;
    }
    // Busy from the start, so a second pick can't run while a large file is read.
    onStatus({ _tag: "importing", percent: 0 });
    const parsed = parseMusicHistoryCsv(await file.text());
    if (parsed._tag !== "parsed") {
      onStatus({
        _tag: "failed",
        message:
          parsed._tag === "empty"
            ? "That file has no listening in it."
            : "Choose Apple Music - Play History Daily Tracks.csv.",
      });
      return;
    }
    const coveredThrough = parsed.rows.reduce(
      (last, row) => (row.day > last ? row.day : last),
      parsed.rows[0]!.day,
    );
    for (let start = 0; start < parsed.rows.length; start += MUSIC_HISTORY_CHUNK_ROWS) {
      onStatus({ _tag: "importing", percent: Math.round((start / parsed.rows.length) * 100) });
      const end = start + MUSIC_HISTORY_CHUNK_ROWS;
      const result = await importHistory({
        environmentId,
        input: {
          rows: parsed.rows.slice(start, end),
          ...(end >= parsed.rows.length ? { coveredThrough } : {}),
        },
      });
      if (result._tag !== "Success") {
        // Saved chunks stay; importing the file again finishes the rest without double counting.
        onStatus({
          _tag: "failed",
          message:
            start === 0
              ? "Import failed. Try again."
              : "Import stopped partway. Import the file again.",
        });
        return;
      }
    }
    onStatus({ _tag: "idle" });
  };

  if (!canImport) return null;
  return (
    <>
      <input
        ref={fileInput}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          void importFile(file).finally(props.onChange);
        }}
      />
      <Menu>
        <MenuTrigger
          render={<Button variant="ghost-muted" size="icon-sm" />}
          aria-label="Listening history"
          disabled={props.importing}
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuGroup>
            <MenuGroupLabel>
              {props.importedThrough === null
                ? "Apple Music - Play History Daily Tracks.csv"
                : `Apple Music history through ${formatDay(props.importedThrough)}`}
            </MenuGroupLabel>
            <MenuItem
              onClick={() => {
                onStatus({ _tag: "idle" });
                fileInput.current?.click();
              }}
            >
              Import Apple Music history…
            </MenuItem>
          </MenuGroup>
          {/* Offered even with no covered day: a stopped first import still leaves rows. */}
          <MenuSeparator />
          <MenuItem
            variant="destructive"
            onClick={() => {
              onStatus({ _tag: "idle" });
              void clearHistory({ environmentId, input: {} }).then(props.onChange);
            }}
          >
            Remove imported history
          </MenuItem>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>Library plays are estimated at full song length</MenuGroupLabel>
          </MenuGroup>
        </MenuPopup>
      </Menu>
    </>
  );
}

function ProjectStats({
  environmentId,
  stats,
}: {
  environmentId: EnvironmentId;
  stats: MusicStats;
}) {
  if (stats.projects.length === 0) return null;
  return (
    <ScrollArea className="max-h-60" scrollFade>
      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-medium text-muted-foreground">While agents worked</h3>
        <ul className="flex flex-col">
          {stats.projects.map((project) => (
            <ProjectStatRow
              key={project.projectId}
              environmentId={environmentId}
              projectId={project.projectId}
              seconds={project.seconds}
            />
          ))}
        </ul>
      </section>
    </ScrollArea>
  );
}

function ProjectStatRow(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  seconds: number;
}) {
  const project = useProject(scopeProjectRef(props.environmentId, props.projectId));
  return (
    <li className="flex items-center gap-2 py-0.5 text-sm">
      <span className="min-w-0 flex-1 truncate">{project?.title ?? "Removed project"}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {formatMusicDuration(props.seconds)}
      </span>
    </li>
  );
}
