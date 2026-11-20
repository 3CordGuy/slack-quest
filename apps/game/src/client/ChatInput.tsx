// The line you type into a place's chat (the Harbor, a hut, the pub), with
// its Say button and the emote wheel (EmoteWheel.tsx). What is being typed is
// kept here and not in the place's view, so a keystroke draws this row again
// and nothing else. A line that is only an emote's name after a slash (/wave)
// is that emote, not a line to say.

import { useState } from "react";
import { emoteTyped, type Emote } from "@gantt-quest/world";
import { EmoteWheel } from "./EmoteWheel";

export function ChatInput({ placeholder, onSay, onEmote }: { placeholder: string; onSay(text: string): void; onEmote?(emote: Emote): void }) {
  const [text, setText] = useState("");
  const say = () => {
    if (!text.trim()) return;
    const emote = onEmote ? emoteTyped(text) : null;
    if (emote) onEmote!(emote);
    else onSay(text);
    setText("");
  };
  return (
    <div className="row">
      {onEmote && <EmoteWheel onEmote={onEmote} />}
      <input value={text} maxLength={200} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && say()} />
      <button disabled={!text.trim()} onClick={say}>Say</button>
    </div>
  );
}
