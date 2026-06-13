export interface IntentRecord {
  createdAt: string;
  intentRef: string;
  summary: string;
}

export interface IntentRecordStore {
  getIntentRecord(intentRef: string): IntentRecord | null;
}
