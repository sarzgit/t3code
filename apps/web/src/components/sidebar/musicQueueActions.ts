import { musicQueueEditBase } from "@t3tools/client-runtime/state/music";
import type {
  EnvironmentId,
  MusicQueueActive,
  MusicQueueEdit,
  MusicQueueRef,
  MusicQueueView,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";

import { musicEnvironment } from "~/state/music";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { toastManager } from "../ui/toast";

/**
 * Sends one edit. A view names the exact list the user saw; an unedited queue known only by
 * its status is read first, because its first edit must send back the song count.
 */
export function useMusicQueueEdit() {
  const editQueue = useAtomCommand(musicEnvironment.editQueue);
  const readQueue = useAtomQueryRunner(musicEnvironment.queueView, { refresh: true });
  return async (
    environmentId: EnvironmentId,
    queue: MusicQueueActive | MusicQueueView,
    edit: MusicQueueEdit,
  ): Promise<MusicQueueRef | null> => {
    let identity: Parameters<typeof musicQueueEditBase>[0] = queue;
    if (!queue.edited && !("upcoming" in queue)) {
      const read = await readQueue({ environmentId, input: { queueId: queue.id } });
      if (read._tag !== "Success") return reportMusicFailure(read.cause);
      identity = read.value;
    }
    const result = await editQueue({
      environmentId,
      input: { ...musicQueueEditBase(identity), edit },
    });
    return result._tag === "Success" ? result.value : reportMusicFailure(result.cause);
  };
}

/** Music commands otherwise fail quietly; a queue action the user can't see needs saying. */
export function reportMusicFailure(cause: Cause.Cause<unknown>): null {
  toastManager.add({ type: "error", title: formatEnvironmentQueryError(cause) });
  return null;
}
