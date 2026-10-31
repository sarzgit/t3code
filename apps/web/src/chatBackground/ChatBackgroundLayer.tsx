import { useChatBackground } from "./chatBackground";

/** Sits behind the timeline; the parent must be `relative isolate` so the negative z-index stays inside it. */
export function ChatBackgroundLayer() {
  const { imageUrl } = useChatBackground();
  if (!imageUrl) return null;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div
        className="chat-background-image absolute"
        style={{ backgroundImage: `url("${imageUrl}")` }}
      />
      {/* Light text on a bright photo needs a heavier veil than dark text does. */}
      <div className="absolute inset-0 bg-background/45 dark:bg-background/70" />
    </div>
  );
}
