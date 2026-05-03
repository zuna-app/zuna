export type Suggestion = {
  query: string;
  start: number;
  results: [string, string][];
  selectedIdx: number;
};
