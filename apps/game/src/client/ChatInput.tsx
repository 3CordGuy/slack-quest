// The line you type into a place's chat (the Harbor, a hut, the pub), with
// its Say button. What is being typed is kept here and not in the place's
// view, so a keystroke draws this row again and nothing else.

import { useState } from "react";

export function ChatInput({ placeholder, onSay }: { placeholder: string; onSay(text: string): void }) {
  const [text, setText] = useState("");
  const say = () => {
    if (!text.trim()) return;
    onSay(text);
    setText("");
  };
  return (
    <div className="row">
      <input value={text} maxLength={200} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && say()} />
      <button disabled={!text.trim()} onClick={say}>Say</button>
    </div>
  );
}
