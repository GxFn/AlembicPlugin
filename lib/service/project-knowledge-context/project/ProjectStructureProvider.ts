export interface ProjectStructureNode {
  id: string;
  label: string;
  type: string;
}

export interface ProjectStructureProvider {
  listStructureNodes(projectRoot?: string): ProjectStructureNode[];
}
