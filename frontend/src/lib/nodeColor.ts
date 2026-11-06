/** Stable colours per node, matching the crew palette where the nickname is known. */
const known: Record<string, string> = {
  Rex: "#83caff",
  Mika: "#b4a0ed",
  Nova: "#dfb69a",
  Ari: "#8ecab3",
  Kai: "#e7a3c6",
  Zoe: "#f2d27a",
  Ivy: "#f0a07a",
  Leo: "#7fd1d9",
  You: "#e7ebf5",
};
const palette = ["#83caff", "#b4a0ed", "#8ecab3", "#dfb69a", "#a1d6ff", "#e7a3c6"];
export function nodeColor(nickname: string | undefined, fallbackIndex = 0) {
  return (nickname && known[nickname]) || palette[fallbackIndex % palette.length];
}
