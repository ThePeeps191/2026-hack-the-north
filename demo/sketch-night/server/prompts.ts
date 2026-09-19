export const PROMPTS = [
  'a kettle with opinions',
  'the last bus of the night',
  'a houseplant that got a promotion',
  'two socks arguing',
  'a sandwich built too tall',
  'rain that only falls indoors',
  'a library card for pigeons',
  'the quietest drum kit',
  'a lighthouse for lost keys',
  'the office microwave at midnight',
];

export function pickPrompt(previous: string | null): string {
  const options = previous ? PROMPTS.filter((item) => item !== previous) : PROMPTS;
  const index = Math.floor(Math.random() * options.length);
  return options[index] ?? PROMPTS[0]!;
}
