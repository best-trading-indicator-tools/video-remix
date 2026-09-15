import { useEffect, useState } from "react";

/** Decorative suggestions stay separate from the user's draft and accessible label. */
export default function PromptHint({ examples, fallback }: { examples: string[]; fallback: string }) {
  const phrases = JSON.stringify(examples.length ? examples : [fallback || "Describe the change you’d like to make."]);
  const [text, setText] = useState("");
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const suggestions: string[] = JSON.parse(phrases);
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timer: ReturnType<typeof setTimeout>;
    let index = 0;
    let length = 0;
    let deleting = false;

    const tick = () => {
      const suggestion = suggestions[index]!;
      length += deleting ? -1 : 1;
      setText(suggestion.slice(0, length));
      let delay = deleting ? 18 : 38;
      if (length === suggestion.length) { deleting = true; delay = 2400; }
      else if (length === 0) { deleting = false; index = (index + 1) % suggestions.length; delay = 450; }
      timer = setTimeout(tick, delay);
    };
    const resume = () => {
      clearTimeout(timer);
      setReducedMotion(preference.matches);
      if (preference.matches) { setText(suggestions[0]!); return; }
      setText(suggestions[index]!.slice(0, length));
      if (!document.hidden) timer = setTimeout(tick, 600);
    };
    resume();
    preference.addEventListener("change", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      clearTimeout(timer);
      preference.removeEventListener("change", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [phrases]);

  return <div className="prompt-editor-hint" aria-hidden="true">
    <span className="prompt-editor-hint-prefix">Try: </span>{text}
    {!reducedMotion && <span className="prompt-editor-hint-caret" />}
  </div>;
}
