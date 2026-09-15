const ignored = new Set(
  "a an and are as at be been but by can could do for from had has have how i if in into is it its just like make more my of on one or our out so some than that the their them then there these they this those to too up us use was we were what when where which who will with would you your video clip footage stock broll mp4 mov webm watch follow look really very also now over".split(
    " ",
  ),
);

export const brollTokens = (value: string) => [
  ...new Set(
    (
      value
        .normalize("NFKC")
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}]+/gu) || []
    )
      .filter((word) => word.length > 2 && !ignored.has(word))
      .map((word) =>
        word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word,
      ),
  ),
];
