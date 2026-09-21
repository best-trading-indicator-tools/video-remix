export function wrapEditorialText(text: string, columns: number): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const output: string[] = [];
      let current = "";
      for (const word of line.split(/\s+/u)) {
        if (!word) continue;
        if (current && Array.from(`${current} ${word}`).length > columns) {
          output.push(current);
          current = "";
        }
        const letters = Array.from(word);
        while (letters.length > columns)
          output.push(letters.splice(0, columns).join(""));
        if (letters.length)
          current += `${current ? " " : ""}${letters.join("")}`;
      }
      if (current) output.push(current);
      return output.join("\n");
    })
    .join("\n");
}
