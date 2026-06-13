export interface RecipeRelationChain {
  hops: string[];
  relationType: string;
}

export interface RecipeRelationChainProvider {
  expandRecipeRelationChains(refId: string, maxHops: number): RecipeRelationChain[];
}
