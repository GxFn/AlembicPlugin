export interface ProjectGraphRelation {
  fromId: string;
  relationType: string;
  toId: string;
}

export interface ProjectGraphProvider {
  resolveProjectRelations(projectRoot?: string): ProjectGraphRelation[];
}
