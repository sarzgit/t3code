import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { formatMusicDuration } from "@t3tools/client-runtime/state/music";
import type { EnvironmentId, MusicStats, MusicStatsInput, ProjectId } from "@t3tools/contracts";
import { useState } from "react";

import { useProject } from "~/state/entities";
import { musicEnvironment } from "~/state/music";
import { useEnvironmentQuery } from "~/state/query";

import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const STATS_RANGES: ReadonlyArray<{ days: MusicStatsInput["days"]; label: string }> = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
];

export function ListeningStats({ environmentId }: { environmentId: EnvironmentId }) {
  const [days, setDays] = useState<MusicStatsInput["days"]>(7);
  const query = useEnvironmentQuery(musicEnvironment.stats({ environmentId, input: { days } }));
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
      ) : stats.totalSec < 60 ? (
        <p className="py-2 text-center text-xs text-muted-foreground">No listening yet</p>
      ) : (
        <ScrollArea className="max-h-72" scrollFade>
          <StatsBody environmentId={environmentId} stats={stats} />
        </ScrollArea>
      )}
    </div>
  );
}

function StatsBody({ environmentId, stats }: { environmentId: EnvironmentId; stats: MusicStats }) {
  const busiest = Math.max(...stats.days.map((day) => day.seconds), 1);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-2xl font-semibold tabular-nums">{formatMusicDuration(stats.totalSec)}</p>
      {stats.days.length > 1 ? (
        <div className="flex h-12 items-end gap-px" aria-hidden>
          {stats.days.map((day) => (
            <div
              key={day.date}
              className="min-h-px flex-1 rounded-t-sm bg-primary/70"
              style={{ height: `${(day.seconds / busiest) * 100}%` }}
            />
          ))}
        </div>
      ) : null}
      <StatsList
        title="Artists"
        rows={stats.artists.map((artist) => ({
          key: artist.name,
          label: artist.name,
          seconds: artist.seconds,
        }))}
      />
      <StatsList
        title="Songs"
        rows={stats.tracks.map((track) => ({
          key: `${track.name}\u0000${track.artist}`,
          label: track.artist ? `${track.name} · ${track.artist}` : track.name,
          seconds: track.seconds,
        }))}
      />
      {stats.projects.length > 0 ? (
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
      ) : null}
    </div>
  );
}

function StatsList(props: {
  title: string;
  rows: ReadonlyArray<{ key: string; label: string; seconds: number }>;
}) {
  if (props.rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
      <ul className="flex flex-col">
        {props.rows.map((row) => (
          <StatRow key={row.key} label={row.label} seconds={row.seconds} />
        ))}
      </ul>
    </section>
  );
}

function StatRow(props: { label: string; seconds: number }) {
  return (
    <li className="flex items-center gap-2 py-0.5 text-sm">
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {formatMusicDuration(props.seconds)}
      </span>
    </li>
  );
}

function ProjectStatRow(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  seconds: number;
}) {
  const project = useProject(scopeProjectRef(props.environmentId, props.projectId));
  return <StatRow label={project?.title ?? "Removed project"} seconds={props.seconds} />;
}
