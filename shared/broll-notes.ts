/** Older exports recorded the same missing cutaway in two pipeline stages. */
export function compactBrollNotes(notes: string[] = []): string[] {
  const generic = /^(?:AI found no sufficiently relevant B-roll match|No suitable AI B-roll match fit this edit|No relevant B-roll was found for this edit)\. Original footage was kept\.$/u;
  const specific = notes.some(note => !generic.test(note) && /B-roll|stock search|stock footage/iu.test(note) && /original footage was kept/iu.test(note));
  return [...new Set(notes.flatMap(note => generic.test(note)
    ? specific ? [] : ["No relevant B-roll was found for this edit. Original footage was kept."]
    : [note]))];
}
