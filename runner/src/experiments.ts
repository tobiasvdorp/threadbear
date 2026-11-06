// Experiments: new features that start off for everyone, with a switch
// in runner.json (`"experiments": { "<id>": true }`) so Mike can run one
// on his own copy first. Once he's happy with it, the experiment and its
// switch are taken out and the feature just runs (AGENTS.md, "Experiments"),
// rather than its default flipping and the switch staying.
//
// Since the repo went public (5 Nov 2026) other people run Threadbear, so
// Mike asked on 6 Nov that features he's still trying out land here
// rather than straight on. Each one names the schedule that asks him,
// a few days after it lands, whether to turn it on for everyone, so
// none is forgotten (AGENTS.md, "Experiments"; experiments.test.ts
// checks every entry has one).
import { readRunnerJson } from './config.ts';

export type Experiment = {
  id: string;
  // What it does, in a few words, for tb status and the guide.
  title: string;
  // The day it landed (YYYY-MM-DD).
  added: string;
  // Whether it's on for anyone whose runner.json doesn't say.
  on: boolean;
  // The schedule (schedule_message's id) that asks Mike whether to flip
  // `on`, or to drop the experiment.
  reminder: string;
};

export const EXPERIMENTS: readonly Experiment[] = [
  {
    id: 'codexSmallJobs',
    title: 'Codex small jobs: titles and librarian can use a Codex model and effort',
    added: '2026-11-06',
    on: false,
    reminder: '6a7ca905',
  },
  {
    id: 'labReview',
    title: 'Review by another lab: a code change is checked by the other provider before the thread finishes',
    added: '2026-11-06',
    on: false,
    reminder: '16b56f61',
  },
  {
    id: 'keepAwake',
    title: "Keep the Mac awake: macOS's caffeinate stops idle sleep while a thread is working",
    added: '2026-11-06',
    on: false,
    reminder: '12503e21',
  },
  {
    id: 'scheduleChecks',
    title: 'Schedule checks: a shell command runs before each scheduled run, and a run whose check prints nothing is skipped',
    added: '2026-11-06',
    on: false,
    reminder: '6328eeda',
  },
  {
    id: 'richBlocks',
    title: 'Diagrams and pages in replies: agents are told the apps draw ```mermaid and ```html blocks',
    added: '2026-11-06',
    on: false,
    reminder: '72b91442',
  },
];

export type ExperimentId = 'labReview' | 'keepAwake' | 'scheduleChecks' | 'richBlocks' | 'codexSmallJobs';

// Read from runner.json each time, so turning one on or off takes effect
// at the next turn, with no restart.
export function experimentOn(home: string, id: ExperimentId): boolean {
  const said = readRunnerJson(home).experiments?.[id];
  if (typeof said === 'boolean') return said;
  return EXPERIMENTS.find((x) => x.id === id)?.on ?? false;
}
