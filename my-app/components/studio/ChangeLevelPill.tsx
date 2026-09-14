// A change level as a pill: the same word and colour on every screen.
// The word and the tone come from CHANGE_LEVEL_PILL (lib/change-level), the one
// table of them; this component only draws it.

import { Pill } from "@/components/ui/Pill";
import { CHANGE_LEVEL_PILL, type ChangeLevel } from "@/lib/change-level";

export function ChangeLevelPill({ level, title }: { level: ChangeLevel; title?: string }) {
  const { word, tone } = CHANGE_LEVEL_PILL[level];
  // No dot for a level nobody recorded: the timeline draws that one's dot in
  // the plain border colour, and a grey dot here would look like patch.
  return (
    <Pill tone={tone} dot={level !== "unknown"} title={title}>
      {word}
    </Pill>
  );
}
