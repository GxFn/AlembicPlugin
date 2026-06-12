import { describe, expect, it } from 'vitest';
import {
  buildHostIntentFrame,
  prepareHostIntentInput,
} from '../../lib/service/task/HostIntentFrame.js';
import { extract as extractIntent } from '../../lib/service/task/IntentExtractor.js';

function frameFrom(input: Parameters<typeof prepareHostIntentInput>[0]) {
  const prepared = prepareHostIntentInput(input);
  const extracted = extractIntent(prepared.userQuery, prepared.activeFile, prepared.language);
  return buildHostIntentFrame(prepared, extracted);
}

describe('HostIntentFrame recognized intent draft', () => {
  it('does not use raw automation envelopes as the effective query when no host intent is declared', () => {
    const rawEnvelope =
      '<codex_delegation><input>dispatchGroup: example</input></codex_delegation>';
    const prepared = prepareHostIntentInput({ userQuery: rawEnvelope });

    expect(prepared.userQuery).toBe('');
    expect(prepared.degraded).toBe(true);
    expect(prepared.degradedReasons).toContain(
      'hostIntent.rawAutomationEnvelopeWithoutDeclaredIntent'
    );
  });

  it('lets host-declared intent override raw automation envelope text', () => {
    const rawEnvelope =
      '<codex_delegation><input>dispatchGroup: example</input></codex_delegation>';
    const prepared = prepareHostIntentInput({
      userQuery: rawEnvelope,
      hostDeclaredIntent: {
        action: 'implement',
        confidence: 0.8,
        query: 'Implement task lifecycle policy',
        sourceRefs: ['lib/runtime/mcp/handlers/task.ts'],
      },
    });
    const extracted = extractIntent(prepared.userQuery, prepared.activeFile, prepared.language);
    const frame = buildHostIntentFrame(prepared, extracted);

    expect(prepared.userQuery).toBe('Implement task lifecycle policy');
    expect(prepared.degradedReasons).not.toContain(
      'hostIntent.rawAutomationEnvelopeWithoutDeclaredIntent'
    );
    expect(frame.recognizedIntentDraft).toMatchObject({
      action: 'implement',
      query: 'Implement task lifecycle policy',
      source: 'mixed',
      sourceRefs: ['lib/runtime/mcp/handlers/task.ts'],
      status: 'recognized',
    });
    expect(JSON.stringify(frame.recognizedIntentDraft)).not.toContain('dispatchGroup');
    expect(JSON.stringify(frame.recognizedIntentDraft)).not.toContain('<codex_delegation>');
  });

  it('builds a recognized draft with source refs and evidence spans from host-declared input', () => {
    const frame = frameFrom({
      userQuery: 'Please implement VideoURLPreloader async bridge',
      activeFile: 'src/player/PlayerController.swift',
      language: 'swift',
      hostDeclaredIntent: {
        action: 'implement',
        confidence: 0.84,
        keywords: ['async', 'bridge'],
        module: 'VideoURLPreloader',
        query: 'VideoURLPreloader async bridge',
        sourceRefs: ['host:intent', '/Users/example/private.ts'],
      },
    });

    expect(frame.recognizedIntentDraft).toMatchObject({
      action: 'implement',
      confidence: 0.84,
      constraints: expect.arrayContaining(['async', 'bridge']),
      degraded: false,
      language: 'swift',
      query: 'VideoURLPreloader async bridge',
      source: 'mixed',
      sourceRefs: ['host:intent'],
      status: 'recognized',
      target: 'VideoURLPreloader',
    });
    expect(frame.recognizedIntentDraft.evidenceSpans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'query', source: 'userQuery' }),
        expect.objectContaining({ field: 'target', source: 'hostDeclaredIntent' }),
        expect.objectContaining({ field: 'constraints', source: 'hostDeclaredIntent' }),
      ])
    );
    expect(JSON.stringify(frame.recognizedIntentDraft)).not.toContain('/Users/example');
  });

  it('keeps deterministic fallback draft but redacts absolute active file context', () => {
    const frame = frameFrom({
      activeFile: '/Users/example/private-project/src/FooService.ts',
      userQuery: 'Review FooService guard rules',
    });

    expect(frame.recognizedIntentDraft).toMatchObject({
      action: 'review',
      confidence: 1,
      source: 'deterministic',
      status: 'recognized',
      target: 'FooService',
    });
    expect(frame.recognizedIntentDraft.evidenceSpans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'target', redacted: true, source: 'activeFile' }),
      ])
    );
    expect(JSON.stringify(frame.recognizedIntentDraft)).not.toContain('/Users/example');
    expect(JSON.stringify(frame.recognizedIntentDraft)).not.toContain('private-project');
  });

  it('marks low-confidence host drafts as needs-confirmation', () => {
    const frame = frameFrom({
      hostDeclaredIntent: {
        confidence: 0.31,
        query: 'maybe adjust the task route',
      },
    });

    expect(frame.degraded).toBe(true);
    expect(frame.degradedReasons).toContain('recognizedIntent.lowConfidence');
    expect(frame.recognizedIntentDraft).toMatchObject({
      confidence: 0.31,
      degraded: true,
      degradedReasons: ['recognizedIntent.lowConfidence'],
      status: 'needs-confirmation',
    });
  });
});
