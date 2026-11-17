import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { useProject } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function HiddenMusicProjectsSettings() {
  const { connectedEnvironments } = useSettingsScope();
  const containerRef = useRef<HTMLDivElement>(null);
  const hidden = connectedEnvironments.flatMap((environment) =>
    (environment.serverConfig?.settings.musicStatsHiddenProjects ?? []).map((projectId) => ({
      environmentId: environment.environmentId,
      environmentLabel: environment.label,
      projectId,
    })),
  );
  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      aria-label="Hidden Music projects"
      className="outline-none"
    >
      <SettingsRow {...searchableSetting("music-hidden-projects")}>
        {hidden.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">
            {connectedEnvironments.length === 0 ? "Reconnect to manage hidden projects." : "None"}
          </p>
        ) : (
          <ul className="flex flex-col py-1">
            {hidden.map((entry) => (
              <HiddenProjectRow
                key={`${entry.environmentId}:${entry.projectId}`}
                {...entry}
                showEnvironment={connectedEnvironments.length > 1}
                onRestored={() => containerRef.current?.focus()}
              />
            ))}
          </ul>
        )}
      </SettingsRow>
    </div>
  );
}

function HiddenProjectRow(props: {
  environmentId: EnvironmentId;
  environmentLabel: string;
  projectId: ProjectId;
  showEnvironment: boolean;
  onRestored: () => void;
}) {
  const project = useProject(scopeProjectRef(props.environmentId, props.projectId));
  const canRestore = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(props.environmentId),
  );
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings);
  const [saving, setSaving] = useState(false);
  const title = project?.title ?? `Removed project (${props.projectId})`;
  return (
    <li className="flex items-center gap-3 py-1">
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm">{title}</span>
        {props.showEnvironment ? (
          <span className="block truncate text-xs text-muted-foreground">
            {props.environmentLabel}
          </span>
        ) : null}
      </div>
      <Button
        variant="outline"
        size="xs"
        disabled={!canRestore || saving}
        aria-label={`Restore ${title} to Music Stats`}
        onClick={() => {
          setSaving(true);
          void saveSettings({
            environmentId: props.environmentId,
            input: {
              patch: {
                setMusicStatsProjectVisibility: { projectId: props.projectId, hidden: false },
              },
            },
          }).then((result) => {
            setSaving(false);
            if (result._tag === "Success") props.onRestored();
            else
              toastManager.add({
                type: "error",
                title: "Project not restored",
                description: "Try again.",
              });
          });
        }}
      >
        Restore
      </Button>
    </li>
  );
}
