import { createFileRoute } from "@tanstack/react-router";

import { MusicMiniPlayer } from "../components/music/MusicMiniPlayer";

export const Route = createFileRoute("/music/mini")({
  component: MusicMiniPlayer,
});
