import { describe, expect, it } from 'vitest';
import { STREAMS, WorkMapSchema, type WorkMap } from '../src/contracts/index.js';
import type { ElAgent, ElProcedure, ProcedureInput } from '../src/elevenlabs.js';
import { kbDocName, renderWorkMap } from '../src/kbsync.js';
import { memoryStore } from '../src/store/memory.js';
import { buildTestApp, envelope, fakeBus, fakeEl, IDS } from './helpers.js';

const WM = '00000000-0000-4000-8000-0000000000f1';
const OLD_WM = '00000000-0000-4000-8000-0000000000f0';
const S1 = '00000000-0000-4000-8000-000000000501';
const S4 = '00000000-0000-4000-8000-000000000504';
const G1 = '00000000-0000-4000-8000-000000000601';

const workmap: WorkMap = WorkMapSchema.parse({
  id: WM,
  workflow_id: IDS.workflow,
  expert_id: '00000000-0000-4000-8000-0000000000e1',
  version: 2,
  status: 'published',
  title: 'Supplier invoice coding',
  language: 'de',
  steps: [
    {
      id: S4,
      key: 'S4',
      ordinal: 4,
      title: 'Code the invoice to a cost center',
      screen_moment: { t_ms: 192_000, label: '03:12 cost center field', event_ids: ['e1'], field: 'cost_center' },
      decision: 'Re-coded opex (4711) to capex (0400)',
      reason: { quote: 'Über 5.000 Euro ist das Anlagevermögen.', quote_en: 'Over 5,000 euros it is a fixed asset.', turn_id: 't1', source_label: 'Sabine, 03:14' },
      guardrail_ids: [G1],
      is_judgment_call: true,
      screen_signature: { app: 'MiniERP', record_kind: 'invoice', field: 'cost_center' },
    },
    {
      id: S1,
      key: 'S1',
      ordinal: 1,
      title: 'Open the invoice',
      screen_moment: { t_ms: 5_000, label: '00:05 invoice list', event_ids: ['e0'] },
      decision: 'Opened #4471',
      reason: null,
      guardrail_ids: [],
      is_judgment_call: false,
      screen_signature: { app: 'MiniERP', record_kind: 'invoice' },
    },
  ],
  guardrails: [
    {
      id: G1,
      key: 'G1',
      kind: 'threshold',
      description: 'Equipment over €5,000 is always capex',
      rule: { '>': [{ var: 'net_amount' }, 5000] },
      consequence: { require: { cost_center: '0400' } },
      quote: 'Alles über 5.000 ist Capex.',
      quote_en: 'Everything over 5,000 is capex.',
      evidence: [{ turn_id: 't1', t_ms: 192_000 }],
    },
  ],
  open_items: [],
});

const dir = `org/${IDS.org}/${WM}/v2`;

function fakeTutor(opts: { branch?: string | null; procedures?: 'ok' | 'fail' } = {}) {
  const calls: string[] = [];
  const procedures: (ElProcedure & ProcedureInput)[] = [{ procedure_id: 'proc_other_workflow', version_id: 'v_other', name: 'x', content: '', type: 'free_form' }];
  const agent: ElAgent = {
    agent_id: 'agent_tutor',
    branch_id: opts.branch === undefined ? 'agtbranch_main' : opts.branch,
    conversation_config: {
      agent: {
        prompt: {
          prompt: 'You are Sidekik…',
          knowledge_base: [
            { type: 'text', name: kbDocName(OLD_WM, 1), id: 'kb_old', usage_mode: 'auto' },
            { type: 'text', name: 'other-workflow.md', id: 'kb_other', usage_mode: 'auto' },
          ],
        },
      },
    },
  };
  const patches: Record<string, any>[] = [];
  let n = 0;
  const el = fakeEl({
    async getAgent() {
      calls.push('getAgent');
      return structuredClone(agent);
    },
    async updateAgent(_id, body) {
      calls.push('updateAgent');
      patches.push(body);
      if (body.conversation_config) agent.conversation_config = body.conversation_config as ElAgent['conversation_config'];
    },
    async createKnowledgeBaseText(name, text) {
      calls.push(`kb:${name}:${text.slice(0, 20)}`);
      return { id: `kb_new_${++n}`, name };
    },
    async deleteKnowledgeBaseDoc(id) {
      calls.push(`deleteKb:${id}`);
    },
    async createProcedure(_agent, branch, body) {
      if (opts.procedures === 'fail') throw new Error('422 procedures');
      calls.push(`proc:${branch}:${body.type}:${body.name}`);
      const p = { procedure_id: `proc_${++n}`, version_id: `ver_${n}`, ...body };
      procedures.push(p);
      return { procedure_id: p.procedure_id };
    },
    async listProcedures() {
      return procedures.map(({ procedure_id, version_id }) => ({ procedure_id, version_id }));
    },
    async deleteProcedure(_agent, _branch, id) {
      calls.push(`deleteProc:${id}`);
      procedures.splice(procedures.findIndex((p) => p.procedure_id === id), 1);
    },
  });
  return { el, calls, patches, procedures, agent };
}

async function setup(tutor = fakeTutor(), files: Record<string, string> = { [`${dir}/workmap.json`]: JSON.stringify(workmap), [`${dir}/AGENT_RULES.md`]: '# Rules for the tutor' }) {
  const store = memoryStore({
    files,
    workmapWorkflows: { [WM]: IDS.workflow, [OLD_WM]: IDS.workflow },
    agentConfigs: [
      { org_id: IDS.org, workmap_id: OLD_WM, version: 1, el_agent_id: 'agent_tutor', kb_doc_id: 'kb_old', procedure_ids: { [S1]: 'proc_old_s1', intervention: 'proc_old_int' } },
    ],
  });
  tutor.procedures.push(
    { procedure_id: 'proc_old_s1', version_id: 'v1', name: 'old', content: '', type: 'free_form' },
    { procedure_id: 'proc_old_int', version_id: 'v1', name: 'old', content: '', type: 'deterministic' },
  );
  const bus = fakeBus();
  const app = await buildTestApp({ store, bus, el: tutor.el });
  await app.ready();
  const publish = () =>
    bus.deliver(
      STREAMS.workmapPublished,
      envelope('workmap.published', { workmap_id: WM, workflow_id: IDS.workflow, version: 2 }, { producer: 'mapper', session_id: WM }),
    );
  return { app, store, publish, tutor };
}

describe('sk:workmap.published → tutor agent', () => {
  it('creates the KB document from AGENT_RULES.md and swaps it for the earlier version', async () => {
    const { app, store, publish, tutor } = await setup();
    await publish();
    expect(tutor.calls[0]).toBe(`kb:${kbDocName(WM, 2)}:# Rules for the tuto`);
    const kbPatch = tutor.patches.find((p) => p.conversation_config)!;
    expect(kbPatch.conversation_config.agent.prompt.prompt).toBe('You are Sidekik…');
    expect(kbPatch.conversation_config.agent.prompt.rag).toEqual({ enabled: true });
    expect(kbPatch.conversation_config.agent.prompt.knowledge_base).toEqual([
      { type: 'text', name: 'other-workflow.md', id: 'kb_other', usage_mode: 'auto' },
      { type: 'text', name: kbDocName(WM, 2), id: 'kb_new_1', usage_mode: 'auto' },
    ]);
    expect(tutor.calls).toContain('deleteKb:kb_old');
    expect(store.data.agentConfigs.find((c) => c.workmap_id === WM)).toMatchObject({ org_id: IDS.org, version: 2, el_agent_id: 'agent_tutor', kb_doc_id: 'kb_new_1' });
    await app.close();
  });

  it('creates a free-form Procedure per step in order plus a structured Intervention, and publishes them', async () => {
    const { app, store, publish, tutor } = await setup();
    await publish();
    expect(tutor.calls.filter((c) => c.startsWith('proc:'))).toEqual([
      'proc:agtbranch_main:free_form:S1: Open the invoice',
      'proc:agtbranch_main:free_form:S4: Code the invoice to a cost center',
      'proc:agtbranch_main:deterministic:Intervention',
    ]);
    const s4 = tutor.procedures.find((p) => p.name.startsWith('S4'))!;
    expect(s4.content).toContain('"Über 5.000 Euro ist das Anlagevermögen." (in English: "Over 5,000 euros it is a fixed asset.")');
    expect(s4.content).toContain('Guardrail G1: Equipment over €5,000 is always capex');
    expect(s4.content).toContain(`replay_moment with step_id ${S4}`);
    expect(tutor.calls).toEqual(expect.arrayContaining(['deleteProc:proc_old_s1', 'deleteProc:proc_old_int']));
    expect(tutor.patches.at(-1)).toEqual({
      procedures: {
        proc_other_workflow: { procedure_id: 'proc_other_workflow', version_id: 'v_other' },
        proc_2: { procedure_id: 'proc_2', version_id: 'ver_2' },
        proc_3: { procedure_id: 'proc_3', version_id: 'ver_3' },
        proc_4: { procedure_id: 'proc_4', version_id: 'ver_4' },
      },
    });
    expect(store.data.agentConfigs.find((c) => c.workmap_id === WM)?.procedure_ids).toEqual({ [S1]: 'proc_2', [S4]: 'proc_3', intervention: 'proc_4' });
    await app.close();
  });

  it('is idempotent per version', async () => {
    const { app, store, publish, tutor } = await setup();
    await publish();
    const calls = tutor.calls.length;
    await publish();
    expect(tutor.calls).toHaveLength(calls);
    expect(store.data.agentConfigs.filter((c) => c.workmap_id === WM)).toHaveLength(1);
    await app.close();
  });

  it('keeps the KB when Procedures fail, and reuses the KB document on the next delivery', async () => {
    const failing = fakeTutor({ procedures: 'fail' });
    const { app, store, publish } = await setup(failing);
    await publish();
    const row = store.data.agentConfigs.find((c) => c.workmap_id === WM)!;
    expect(row).toMatchObject({ kb_doc_id: 'kb_new_1', procedure_ids: {} });
    await publish();
    expect(failing.calls.filter((c) => c.startsWith('kb:'))).toHaveLength(1);
    await app.close();
  });

  it('renders the KB document from workmap.json when AGENT_RULES.md is missing', async () => {
    const { app, publish, tutor } = await setup(fakeTutor(), { [`${dir}/workmap.json`]: JSON.stringify(workmap) });
    await publish();
    expect(tutor.calls[0]).toBe(`kb:${kbDocName(WM, 2)}:# Supplier invoice c`);
    expect(renderWorkMap(workmap)).toMatch(/### S1\. Open the invoice[\s\S]*### S4\./);
    await app.close();
  });

  it('fails the event when the Work Map is not in Storage, so the bus retries it', async () => {
    const { app, publish } = await setup(fakeTutor(), {});
    await expect(publish()).rejects.toThrow(/workmap\.json not found/);
    await app.close();
  });
});
