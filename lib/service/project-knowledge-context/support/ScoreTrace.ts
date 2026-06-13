export interface ScoreTraceEntry {
  label: string;
  reason: string;
  score: number;
  sourceRef?: string;
}

export interface ScoreTrace {
  entries: ScoreTraceEntry[];
  totalScore: number;
}

export function createScoreTrace(entries: readonly ScoreTraceEntry[]): ScoreTrace {
  return {
    entries: [...entries],
    totalScore: entries.reduce((sum, entry) => sum + entry.score, 0),
  };
}
