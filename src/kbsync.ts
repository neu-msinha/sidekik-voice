import type { FastifyBaseLogger } from 'fastify';
import { WorkMapSchema, type Envelope, type Guardrail, type Step, type WorkMap, type WorkMapPublished } from './contracts/index.js';
import type { ElevenLabsClient, KnowledgeBaseLocator, ProcedureInput } from './elevenlabs.js';
import type { AgentConfigRow, Store } from './store/types.js';

export const INTERVENTION = 'intervention';

/** `workmap-{id}-v{n}.md`: the Tutor's knowledge-base document for one Work Map version (DESIGN §4). */
export const kbDocName = (workmapId: string, version: number) => `workmap-${workmapId}-v${version}.md`;

export type KbSyncDeps = { store: Store; el: ElevenLabsClient; tutorAgentId: string; log: FastifyBaseLogger };

/**
 * `sk:workmap.published` → the Tutor agent (DESIGN §4, ticket 6):
 * 1. loads the map from Storage (`workmaps/org/{org}/{id}/v{n}/`);
 * 2. creates the KB document `workmap-{id}-v{n}.md` (mapper's AGENT_RULES.md) and attaches it with
 *    RAG on, detaching and deleting the documents of the workflow's earlier versions;
 * 3. creates one free-form Procedure per step and one structured "Intervention" Procedure, and
 *    publishes them in place of the earlier versions' Procedures;
 * 4. records the ids in `agent_configs`.
 * Idempotent per version: the row is written as soon as the document exists, and a version whose
 * row already has its document and Procedures is skipped. A Procedure failure is logged and
 * leaves the KB in place (ARCHITECTURE §9 cut order: Procedures → KB + prompt).
 */
export function kbSyncHandler({ store, el, tutorAgentId, log: baseLog }: KbSyncDeps) {
  return async (ev: Envelope<WorkMapPublished>): Promise<void> => {
    const started = Date.now();
    const { workmap_id, workflow_id, version } = ev.data;
    const log = baseLog.child({ session_id: ev.session_id, org_id: ev.org_id, event_id: ev.id, workmap_id, version });

    const existing = await store.getAgentConfig(workmap_id, version);
    if (existing?.kb_doc_id && Object.keys(existing.procedure_ids).length > 0) {
      log.info('work map version already synced');
      return;
    }

    const dir = `org/${ev.org_id}/${workmap_id}/v${version}`;
    const [mapJson, rules] = await Promise.all([store.readWorkmapFile(`${dir}/workmap.json`), store.readWorkmapFile(`${dir}/AGENT_RULES.md`)]);
    // Mapper writes Storage before it publishes the event, so a missing file is an error worth retrying.
    if (!mapJson) throw new Error(`workmaps/${dir}/workmap.json not found`);
    const workmap = WorkMapSchema.parse(JSON.parse(mapJson));

    const earlier = (await store.listWorkflowAgentConfigs(workflow_id)).filter((c) => !(c.workmap_id === workmap_id && c.version === version));

    // 1–2. The KB document, attached in place of the workflow's earlier versions.
    let kbDocId = existing?.kb_doc_id ?? null;
    if (!kbDocId) {
      const name = kbDocName(workmap_id, version);
      kbDocId = (await el.createKnowledgeBaseText(name, rules ?? renderWorkMap(workmap))).id;
      const row: AgentConfigRow = { org_id: ev.org_id, workmap_id, version, el_agent_id: tutorAgentId, kb_doc_id: kbDocId, procedure_ids: {} };
      if (existing) await store.updateAgentConfig(workmap_id, version, { kb_doc_id: kbDocId });
      else await store.insertAgentConfig(row);
    }
    const agent = await el.getAgent(tutorAgentId);
    const prompt = agent.conversation_config?.agent?.prompt ?? {};
    const stale = new Set(earlier.map((c) => c.kb_doc_id).filter((id): id is string => !!id));
    const knowledgeBase: KnowledgeBaseLocator[] = [
      ...(prompt.knowledge_base ?? []).filter((d) => d.id !== kbDocId && !stale.has(d.id)),
      { type: 'text', name: kbDocName(workmap_id, version), id: kbDocId, usage_mode: 'auto' },
    ];
    await el.updateAgent(tutorAgentId, {
      conversation_config: { agent: { prompt: { ...prompt, knowledge_base: knowledgeBase, rag: { ...(prompt.rag as object), enabled: true } } } },
    });
    for (const id of stale) await el.deleteKnowledgeBaseDoc(id).catch((err) => log.warn({ err, kb_doc_id: id }, 'old KB document not deleted'));

    // 3. Procedures.
    let procedureIds: Record<string, string> = existing?.procedure_ids ?? {};
    try {
      procedureIds = await syncProcedures({ el, tutorAgentId, branchId: agent.branch_id, workmap, earlier, log });
    } catch (err) {
      log.warn({ err }, 'procedures not synced; the tutor has the KB document');
    }

    // 4. The record.
    await store.updateAgentConfig(workmap_id, version, { kb_doc_id: kbDocId, procedure_ids: procedureIds });
    log.info(
      { kb_doc_id: kbDocId, procedures: Object.keys(procedureIds).length, replaced: earlier.length, latency_ms: Date.now() - started },
      'work map synced to the tutor agent',
    );
  };
}

async function syncProcedures(args: {
  el: ElevenLabsClient;
  tutorAgentId: string;
  branchId: string | null | undefined;
  workmap: WorkMap;
  earlier: AgentConfigRow[];
  log: FastifyBaseLogger;
}): Promise<Record<string, string>> {
  const { el, tutorAgentId, branchId, workmap, earlier, log } = args;
  if (!branchId) throw new Error('the tutor agent has no branch_id');

  const ids: Record<string, string> = {};
  for (const step of [...workmap.steps].sort((a, b) => a.ordinal - b.ordinal)) {
    ids[step.id] = (await el.createProcedure(tutorAgentId, branchId, stepProcedure(workmap, step))).procedure_id;
  }
  ids[INTERVENTION] = (await el.createProcedure(tutorAgentId, branchId, interventionProcedure(workmap))).procedure_id;

  for (const id of earlier.flatMap((c) => Object.values(c.procedure_ids))) {
    await el.deleteProcedure(tutorAgentId, branchId, id).catch((err) => log.warn({ err, procedure_id: id }, 'old procedure not deleted'));
  }
  // Publishing replaces the agent's whole set, so it lists every Procedure left on the branch.
  const published: Record<string, { procedure_id: string; version_id: string }> = {};
  for (const p of await el.listProcedures(tutorAgentId, branchId)) {
    if (p.version_id) published[p.procedure_id] = { procedure_id: p.procedure_id, version_id: p.version_id };
    else if (Object.values(ids).includes(p.procedure_id)) log.warn({ procedure_id: p.procedure_id }, 'new procedure has no version to publish');
  }
  await el.updateAgent(tutorAgentId, { procedures: published });
  return ids;
}

const quoted = (q: { quote: string; quote_en?: string | undefined }) => (q.quote_en && q.quote_en !== q.quote ? `"${q.quote}" (in English: "${q.quote_en}")` : `"${q.quote}"`);

function stepProcedure(workmap: WorkMap, step: Step): ProcedureInput {
  const guardrails = workmap.guardrails.filter((g) => step.guardrail_ids.includes(g.id));
  const where = [step.screen_signature.app, step.screen_signature.record_kind, step.screen_signature.field].filter(Boolean).join(' › ');
  const lines = [
    `Step ${step.key} of "${workmap.title}": ${step.title}.`,
    `When: the learner is at ${step.screen_moment.label} (${where}).`,
    `The expert's decision: ${step.decision}.`,
    step.reason ? `Why, in the expert's words (${step.reason.source_label}): ${quoted(step.reason)}.` : 'The expert gave no reason for this step; do not invent one.',
    ...guardrails.map((g) => `Guardrail ${g.key}: ${g.description}. The expert: ${quoted(g)}.`),
    step.is_judgment_call
      ? 'This is a judgment call: before the learner acts, ask what they would decide and why, then confirm or explain with the expert\'s reason.'
      : 'Let the learner do this step; only explain if they ask or get it wrong.',
    `If you need the expert's recorded moment, call replay_moment with step_id ${step.id}.`,
  ];
  return { name: `${step.key}: ${step.title}`.slice(0, 120), content: lines.join('\n'), type: 'free_form' };
}

function interventionProcedure(workmap: WorkMap): ProcedureInput {
  const lines = [
    'Follow this when a message starts with "[SIDEKIK] INTERVENE:".',
    '1. Stop the learner at once: say "Hold on before you save."',
    '2. Name the guardrail from the message and give the expert\'s reason in their own words, quoted.',
    '3. Offer to replay the expert\'s moment. If the learner agrees, call replay_moment with the step_id from the message.',
    '4. Tell the learner which field to change; call highlight_field for it.',
    '5. Wait for the fix. Do not move on, and never invent a rule that is not listed below.',
    '',
    `Guardrails of "${workmap.title}":`,
    ...workmap.guardrails.map((g: Guardrail) => `- ${g.key}: ${g.description}. The expert: ${quoted(g)}.`),
  ];
  return { name: 'Intervention', content: lines.join('\n'), type: 'deterministic' };
}

/** The KB document when mapper's AGENT_RULES.md is missing: steps and guardrails in plain Markdown. */
export function renderWorkMap(workmap: WorkMap): string {
  const steps = [...workmap.steps].sort((a, b) => a.ordinal - b.ordinal);
  return [
    `# ${workmap.title} (v${workmap.version})`,
    '',
    '## Steps',
    ...steps.flatMap((s) => [
      `### ${s.key}. ${s.title}`,
      `- When: ${s.screen_moment.label}`,
      `- Decision: ${s.decision}`,
      ...(s.reason ? [`- Why: ${quoted(s.reason)} (${s.reason.source_label})`] : []),
      '',
    ]),
    '## Guardrails',
    ...workmap.guardrails.map((g) => `- **${g.key}** ${g.description}. The expert: ${quoted(g)}`),
    '',
  ].join('\n');
}
