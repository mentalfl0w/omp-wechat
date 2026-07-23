/**
 * Split long text at paragraph/line/space boundaries.
 * WeChat text limit is ~2000 characters per message.
 */
export function chunkText(text: string, limit = 2000): string[] {
  if (text.length <= limit) return [text];

  const out: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    const para = rest.lastIndexOf("\n\n", limit);
    const line = rest.lastIndexOf("\n", limit);
    const space = rest.lastIndexOf(" ", limit);
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;

    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }

  if (rest) out.push(rest);
  return out;
}
