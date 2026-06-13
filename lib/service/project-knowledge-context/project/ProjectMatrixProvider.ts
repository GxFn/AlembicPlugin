export interface ProjectMatrixNode {
  detailRefId?: string;
  id: string;
  label: string;
  type: string;
}

export interface ProjectMatrixProvider {
  resolveMatrixNodes(projectRoot?: string): ProjectMatrixNode[];
}
