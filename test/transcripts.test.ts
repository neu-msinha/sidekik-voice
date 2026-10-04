import { describe, expect, it } from 'vitest';
import { STREAMS, type TranscriptTurn } from '../src/contracts/index.js';
import { memoryStore } from '../src/store/memory.js';
import { buildTestApp, envelope, fakeBus, IDS, sessionRow } from './helpers.js';

const turn = (overrides: Partial<TranscriptTurn> = {}): TranscriptTurn => ({
  turn_id: 'turn-1',
  role: 'user',
  text: 'Die geht auf 0400, weil es Anlagevermögen ist.',
  lang: 'de',
  source: 'live',
  redacted: true,
  ...overrides,
});

async function setup(sessions = [sessionRow()]) {
  const store = memoryStore({ sessions });
  const bus = fakeBus();
  const app = await buildTestApp({ store, bus });
  await app.ready();
  return { app, store, bus };
}

describe('sk:transcript.turns consumer', () => {
  it('stores each turn as live with the envelope time', async () => {
    const { app, store, bus } = await setup();
    await bus.deliver(STREAMS.turns, envelope('transcript.turn', turn(), { t_ms: 192_000 }));
    expect(store.data.turns).toEqual([
      {
        org_id: IDS.org,
        session_id: IDS.session,
        turn_id: 'turn-1',
        role: 'user',
        text_redacted: 'Die geht auf 0400, weil es Anlagevermögen ist.',
        lang: 'de',
        t_ms: 192_000,
        source: 'live',
        off_record: false,
      },
    ]);
    await app.close();
  });

  it('keeps the first copy of a turn delivered twice', async () => {
    const { app, store, bus } = await setup();
    await bus.deliver(STREAMS.turns, envelope('transcript.turn', turn(), { t_ms: 1000 }));
    await bus.deliver(STREAMS.turns, envelope('transcript.turn', turn({ text: 'changed' }), { t_ms: 1000 }));
    expect(store.data.turns).toHaveLength(1);
    expect(store.data.turns[0]?.text_redacted).toMatch(/^Die geht/);
    await app.close();
  });

  it('ignores replay sessions and unknown sessions', async () => {
    const { app, store, bus } = await setup([sessionRow({ mode: 'replay' })]);
    await bus.deliver(STREAMS.turns, envelope('transcript.turn', turn()));
    await bus.deliver(STREAMS.turns, envelope('transcript.turn', turn(), { session_id: 'missing' }));
    expect(store.data.turns).toEqual([]);
    await app.close();
  });

  it('takes the org from the session row', async () => {
    const { app, store, bus } = await setup();
    await bus.deliver(STREAMS.turns, envelope('transcript.turn', turn(), { org_id: 'spoofed-org' }));
    expect(store.data.turns[0]?.org_id).toBe(IDS.org);
    await app.close();
  });
});
