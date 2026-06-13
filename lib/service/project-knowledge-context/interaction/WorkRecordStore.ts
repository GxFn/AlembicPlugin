export interface WorkRecord {
  createdAt: string;
  title: string;
  workRef: string;
}

export interface WorkRecordStore {
  getWorkRecord(workRef: string): WorkRecord | null;
}
