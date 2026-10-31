import { useRenderedAppearance } from "../hooks/useTheme";
import { useChatBackground } from "./chatBackground";

/** Sits behind the timeline; the parent must be `relative isolate` so the negative z-index stays inside it. */
export function ChatBackgroundLayer() {
  const { imageUrl, veil } = useChatBackground();
  const appearance = useRenderedAppearance();
  if (!imageUrl || !veil) return null;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div
        className="chat-background-image absolute"
        style={{ backgroundImage: `url("${imageUrl}")` }}
      />
      <div className="absolute inset-0 bg-background" style={{ opacity: veil[appearance] }} />
    </div>
  );
}
