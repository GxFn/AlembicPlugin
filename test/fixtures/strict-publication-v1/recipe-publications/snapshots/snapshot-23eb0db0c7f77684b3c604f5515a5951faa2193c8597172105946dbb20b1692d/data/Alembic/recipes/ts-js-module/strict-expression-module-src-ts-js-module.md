---
id: 4aa3c7c6-a54d-51dc-8c59-1a730642ad4a
title: Strict ts-js-module result boundary
trigger: "@strict-expression-module-src-ts-js-module"
lifecycle: active
language: en
dimensionId: ts-js-module
category: ts-js-module
kind: rule
knowledgeType: code-pattern
complexity: intermediate
scope: "module:src"
description: Preserve the typed Result boundary and frozen evidence lineage.
source: alembic-agent
moduleName: "module:src"
topicHint: ts-js-module
whenClause: Apply this rule to ts-js-module changes in the owned module.
doClause: Preserve the typed Result boundary and frozen evidence lineage.
dontClause: Do not bypass the strict result boundary.
usageGuide: Apply this rule to ts-js-module changes in the owned module.
createdBy: strict-production
createdAt: 1784217928
updatedAt: 1784217928
publishedAt: 1784217928
publishedBy: strict-production
sourceFile: Alembic/recipes/ts-js-module/strict-expression-module-src-ts-js-module.md
tags: ["strict-production","ts-js-module"]
_content: {"pattern":"","markdown":"The ts-js-module path preserves the typed Result boundary.","rationale":"Apply this rule to ts-js-module changes in the owned module.","steps":[],"codeChanges":[],"verification":null}
_relations: {"inherits":[],"implements":[],"calls":[],"depends_on":[],"data_flow":[],"conflicts":[],"extends":[],"related":[{"target":"f7493877-45f6-5f94-be81-a349fcf5db79","description":"auto-discovered"},{"target":"8d780b34-c413-522f-a101-a68d5b9084d9","description":"auto-discovered"},{"target":"5d649a2f-c655-5b0b-8208-34d746ac6458","description":"auto-discovered"}],"alternative":[],"prerequisite":[],"deprecated_by":[],"solves":[],"enforces":[],"references":[]}
_constraints: {"guards":[],"boundaries":[],"preconditions":[],"sideEffects":[]}
_reasoning: {"whyStandard":"Apply this rule to ts-js-module changes in the owned module.","sources":["E-1"],"confidence":1,"qualitySignals":{},"alternatives":[]}
_quality: {"completeness":0,"adaptation":0,"documentation":0,"overall":0,"grade":"F"}
_stats: {"views":0,"adoptions":0,"applications":0,"guardHits":0,"searchHits":0,"authority":0,"lastHitAt":null,"lastSearchedAt":null,"lastGuardHitAt":null,"hitsLast30d":0,"hitsLast90d":0,"searchHitsLast30d":0,"version":1,"ruleFalsePositiveRate":null}
_lifecycleHistory: [{"from":"pending","to":"active","at":1784217928,"by":"strict-production"}]
_retrievalProfile: {"schemaVersion":"1","primaryLanguage":"en","summary":{"primary":"Preserve the typed Result boundary and frozen evidence lineage.","technicalEnglish":"Preserve the typed Result boundary and frozen evidence lineage."},"concepts":[{"term":"strict ts-js-module result boundary","language":"en","provenanceRefs":["E-1"]}],"scenarios":[{"text":"Apply this rule to ts-js-module changes in the owned module.","language":"en","provenanceRefs":["E-1"]}],"exclusions":[{"text":"Do not bypass the strict result boundary.","language":"en","provenanceRefs":["E-1"]}],"provenance":{"evidenceRefs":["E-1"],"sourceFieldRefs":["field:title","field:language","field:dimensionId","field:category","field:knowledgeType","field:kind","field:tags","field:description","field:trigger","field:topicHint","field:moduleName","field:whenClause","field:doClause","field:dontClause","field:usageGuide","field:content.markdown","field:content.rationale"],"sourceContentHash":"81c75ac8cb85bbc78546abbe5dd093b1b8ef671f1e842ab96a10b598aa30218b","generator":"alembic-main-strict-production-v1"}}
_aiInsight: "Apply this rule to ts-js-module changes in the owned module."
_contentHash: c191d1b2544c5ed8
---

The ts-js-module path preserves the typed Result boundary.
