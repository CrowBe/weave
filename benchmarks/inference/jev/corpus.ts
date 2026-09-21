/**
 * Labeled decision records in Weave's own domain.
 *
 * Each record is a state a runtime could actually hold plus the eligible
 * candidates it could dispatch from that state, with the candidate a careful
 * reader would dispatch. Prohibited candidates never reach a judgment site
 * (ARCHITECTURE.md §4), so every candidate here is eligible and the question is
 * only which one advances the goal.
 *
 * `contrast` groups follow the methodology in `benchmarks/inference/README.md`:
 * a `relevant` arm perturbs the field the decision turns on and the answer must
 * move; an `irrelevant` arm perturbs a field the state says does not bear on it
 * and the answer must hold. Those two rates say more than accuracy does,
 * because a state-blind predictor cannot pass either by construction.
 *
 * Authored in-repo by the harness author. See the README's limits: this
 * measures the author's expectations alongside the model.
 */

/** What the judgment site discloses. Already authority- and disclosure-filtered. */
export interface DecisionState {
  readonly goal: string;
  readonly situation: string;
  readonly facts: readonly string[];
}

export interface CandidateOption {
  readonly candidate_id: string;
  readonly operation: string;
  readonly summary: string;
}

export interface ContrastMembership {
  /** Records sharing a group are compared against each other, never pooled. */
  readonly group: string;
  readonly arm: 'relevant' | 'irrelevant';
}

export interface DecisionCase {
  readonly id: string;
  /** Grouping for the per-source breakdown. Floors are computed per source. */
  readonly source: string;
  readonly state: DecisionState;
  readonly candidates: readonly CandidateOption[];
  /** The `candidate_id` that best advances the goal from this state. */
  readonly label: string;
  readonly contrast?: ContrastMembership;
}

const inspectBeta: CandidateOption = {
  candidate_id: 'c_inspect_beta',
  operation: 'source.inspect',
  summary: 'Inspect source beta, which the goal names and which has not been read.',
};
const assemble: CandidateOption = {
  candidate_id: 'c_assemble',
  operation: 'report.assemble',
  summary: 'Assemble the report from the sources inspected so far.',
};
const complete: CandidateOption = {
  candidate_id: 'c_complete',
  operation: 'goal.complete',
  summary: 'Declare the goal complete.',
};
const publish: CandidateOption = {
  candidate_id: 'c_publish',
  operation: 'report.publish',
  summary: 'Publish the assembled report to the reporting resource.',
};
const requestApproval: CandidateOption = {
  candidate_id: 'c_approval',
  operation: 'approval.request',
  summary: 'Ask the entitled principal to approve the pending effect.',
};
const askClarification: CandidateOption = {
  candidate_id: 'c_clarify',
  operation: 'clarification.request',
  summary: 'Ask the requester which sources the goal is meant to cover.',
};
const reuseCached: CandidateOption = {
  candidate_id: 'c_reuse',
  operation: 'conclusion.reuse',
  summary: 'Reuse the recorded cached conclusion instead of inferring again.',
};
const inferAgain: CandidateOption = {
  candidate_id: 'c_infer',
  operation: 'inference.request',
  summary: 'Request inference to derive the conclusion again.',
};

export const CORPUS: readonly DecisionCase[] = [
  // --- a dependency is unmet; the unblocking action is the work -------------
  {
    id: 'blocked.beta-unread',
    source: 'frontier_blocked',
    state: {
      goal: 'Produce one report covering sources alpha and beta.',
      situation: 'Alpha has been inspected and recorded. Beta has not been read.',
      facts: [
        'The report contract requires findings from every source the goal names.',
        'Beta is registered and the goal authorizes reading it.',
      ],
    },
    candidates: [assemble, inspectBeta, complete, publish],
    label: 'c_inspect_beta',
  },
  {
    id: 'blocked.unapproved-publish',
    source: 'frontier_blocked',
    state: {
      goal: 'Publish the assembled report under the authority granted for this goal.',
      situation: 'The report is assembled and checked. Publishing is an effect that policy marks approval-required, and no approval is recorded.',
      facts: [
        'The goal ceiling permits the effect once an entitled principal approves it.',
        'No approval observation exists for this request.',
      ],
    },
    candidates: [publish, requestApproval, complete],
    label: 'c_approval',
  },

  // --- authority or intent is insufficient; asking is progress --------------
  {
    id: 'authority.unnamed-source',
    source: 'frontier_authority',
    state: {
      goal: 'Summarize the records the requester asked about.',
      situation: "The goal's read authority covers alpha only. The requester's wording also mentions gamma, which is registered but unauthorized.",
      facts: [
        'Evidence is not authorization and inferred intent is not consent.',
        'Alpha alone may or may not be what the requester meant.',
      ],
    },
    candidates: [assemble, askClarification, complete],
    label: 'c_clarify',
  },
  {
    id: 'authority.read-only-grant',
    source: 'frontier_authority',
    state: {
      goal: 'Remove the stale records identified in the last cycle.',
      situation: 'The grant for this goal carries the read effect only. Deletion is outside it.',
      facts: [
        'The goal ceiling allows an entitled principal to approve deletion.',
        'The stale records have been identified and recorded.',
      ],
    },
    candidates: [
      { candidate_id: 'c_delete', operation: 'resource.delete', summary: 'Delete the stale records now.' },
      requestApproval,
      complete,
    ],
    label: 'c_approval',
  },

  // --- the work is done; more work is not progress --------------------------
  {
    id: 'complete.published-and-checked',
    source: 'frontier_complete',
    state: {
      goal: 'Produce and publish one report covering alpha and beta.',
      situation: 'Both sources were inspected, the report was assembled, published, and the publication was checked against the contract.',
      facts: ['Every success condition the goal declares is recorded as met.'],
    },
    candidates: [publish, complete, inspectBeta],
    label: 'c_complete',
  },
  {
    id: 'complete.no-remaining-work',
    source: 'frontier_complete',
    state: {
      goal: 'Answer the requester’s question from source alpha.',
      situation: 'Alpha was inspected, the answer was assembled and delivered, and the requester raised nothing further.',
      facts: ['The goal names no other source and no other success condition.'],
    },
    candidates: [assemble, complete, askClarification],
    label: 'c_complete',
  },

  // --- contrast: a cached conclusion, and whether its dependencies moved ----
  {
    id: 'cache.deps-unchanged',
    source: 'contrast_cache',
    state: {
      goal: 'Report the current classification of source alpha.',
      situation: 'A cached conclusion for this classification is recorded with its evidence. Every dependency revision it names still matches the current state, and its invalidation conditions have not fired.',
      facts: [
        'Reuse requires the dependency revisions and access permissions to remain valid. Both hold.',
        'The cached conclusion is within the authority scope of this goal.',
      ],
    },
    candidates: [reuseCached, inferAgain],
    label: 'c_reuse',
    contrast: { group: 'cache_deps', arm: 'relevant' },
  },
  {
    id: 'cache.deps-changed',
    source: 'contrast_cache',
    state: {
      goal: 'Report the current classification of source alpha.',
      situation: 'A cached conclusion for this classification is recorded with its evidence. Source alpha has since been revised, so a dependency revision the conclusion names no longer matches the current state.',
      facts: [
        'Reuse requires the dependency revisions and access permissions to remain valid. The revision no longer holds.',
        'The cached conclusion is within the authority scope of this goal.',
      ],
    },
    candidates: [reuseCached, inferAgain],
    label: 'c_infer',
    contrast: { group: 'cache_deps', arm: 'relevant' },
  },
  {
    id: 'cache.requester-ben',
    source: 'contrast_cache',
    state: {
      goal: 'Report the current classification of source alpha.',
      situation: 'A cached conclusion is recorded and every dependency revision it names still matches. The request arrived from the operator on the morning queue.',
      facts: [
        'Reuse requires the dependency revisions and access permissions to remain valid. Both hold.',
        'Which queue a request arrived on does not bear on whether a conclusion may be reused.',
      ],
    },
    candidates: [reuseCached, inferAgain],
    label: 'c_reuse',
    contrast: { group: 'cache_queue', arm: 'irrelevant' },
  },
  {
    id: 'cache.requester-sam',
    source: 'contrast_cache',
    state: {
      goal: 'Report the current classification of source alpha.',
      situation: 'A cached conclusion is recorded and every dependency revision it names still matches. The request arrived from the operator on the overnight queue.',
      facts: [
        'Reuse requires the dependency revisions and access permissions to remain valid. Both hold.',
        'Which queue a request arrived on does not bear on whether a conclusion may be reused.',
      ],
    },
    candidates: [reuseCached, inferAgain],
    label: 'c_reuse',
    contrast: { group: 'cache_queue', arm: 'irrelevant' },
  },

  // --- contrast: whether the approval that gates the effect exists ----------
  {
    id: 'approval.granted',
    source: 'contrast_approval',
    state: {
      goal: 'Publish the assembled report under the authority granted for this goal.',
      situation: 'The report is assembled and checked. An entitled principal approved this bound request, within their authority and the goal ceiling, and the approval is recorded and unexpired.',
      facts: ['Policy marks publishing approval-required. The requirement is satisfied.'],
    },
    candidates: [publish, requestApproval],
    label: 'c_publish',
    contrast: { group: 'approval_present', arm: 'relevant' },
  },
  {
    id: 'approval.absent',
    source: 'contrast_approval',
    state: {
      goal: 'Publish the assembled report under the authority granted for this goal.',
      situation: 'The report is assembled and checked. No approval observation exists for this bound request.',
      facts: ['Policy marks publishing approval-required. The requirement is not satisfied.'],
    },
    candidates: [publish, requestApproval],
    label: 'c_approval',
    contrast: { group: 'approval_present', arm: 'relevant' },
  },
  {
    id: 'approval.short-report',
    source: 'contrast_approval',
    state: {
      goal: 'Publish the assembled report under the authority granted for this goal.',
      situation: 'The report is assembled, checked, and runs to three pages. An entitled principal approved this bound request and the approval is recorded and unexpired.',
      facts: [
        'Policy marks publishing approval-required. The requirement is satisfied.',
        'The length of the report does not bear on whether the effect is permitted.',
      ],
    },
    candidates: [publish, requestApproval],
    label: 'c_publish',
    contrast: { group: 'approval_length', arm: 'irrelevant' },
  },
  {
    id: 'approval.long-report',
    source: 'contrast_approval',
    state: {
      goal: 'Publish the assembled report under the authority granted for this goal.',
      situation: 'The report is assembled, checked, and runs to forty pages. An entitled principal approved this bound request and the approval is recorded and unexpired.',
      facts: [
        'Policy marks publishing approval-required. The requirement is satisfied.',
        'The length of the report does not bear on whether the effect is permitted.',
      ],
    },
    candidates: [publish, requestApproval],
    label: 'c_publish',
    contrast: { group: 'approval_length', arm: 'irrelevant' },
  },

  // --- a plausible distractor that does not advance the goal ----------------
  {
    id: 'distractor.more-documentation',
    source: 'frontier_distractor',
    state: {
      goal: 'Make the pending report publishable under the authority already granted.',
      situation: 'The report is assembled. One required check has not been run, and the approval is already recorded.',
      facts: [
        'The contract requires the check before publication.',
        'Documentation is not among the goal’s success conditions.',
      ],
    },
    candidates: [
      { candidate_id: 'c_document', operation: 'notes.write', summary: 'Write documentation describing the authority contract.' },
      { candidate_id: 'c_check', operation: 'report.check', summary: 'Run the outstanding contract check against the assembled report.' },
      publish,
      complete,
    ],
    label: 'c_check',
  },
  {
    id: 'distractor.rewrite-first',
    source: 'frontier_distractor',
    state: {
      goal: 'Deliver the requested answer from source alpha this cycle.',
      situation: 'Alpha is registered and authorized and has not been read. The scheduler is synchronous, which is a known limitation unrelated to this goal.',
      facts: [
        'The goal names one source and one answer.',
        'Rewriting the scheduler is not required to read alpha.',
      ],
    },
    candidates: [
      { candidate_id: 'c_rewrite', operation: 'runtime.refactor', summary: 'Rewrite the scheduler to be asynchronous before proceeding.' },
      { candidate_id: 'c_inspect_alpha', operation: 'source.inspect', summary: 'Inspect source alpha, which the goal names.' },
      complete,
    ],
    label: 'c_inspect_alpha',
  },

  // --- waiting is an action, and sometimes the right one -------------------
  {
    id: 'waiting.dependency-in-flight',
    source: 'frontier_waiting',
    state: {
      goal: 'Produce one report covering alpha and beta.',
      situation: 'Alpha is recorded. An inspection of beta was dispatched this cycle and has not returned. No other eligible work depends only on alpha.',
      facts: [
        'The report contract requires findings from every source the goal names.',
        'Dispatching a second inspection of beta would duplicate an in-flight effect.',
      ],
    },
    candidates: [
      { candidate_id: 'c_wait', operation: 'thread.wait', summary: 'Wait for the in-flight inspection of beta to return.' },
      inspectBeta,
      assemble,
      complete,
    ],
    label: 'c_wait',
  },
  {
    id: 'waiting.nothing-in-flight',
    source: 'frontier_waiting',
    state: {
      goal: 'Produce one report covering alpha and beta.',
      situation: 'Alpha is recorded. Nothing is in flight. Beta is registered, authorized, and unread.',
      facts: [
        'The report contract requires findings from every source the goal names.',
        'Waiting advances no work when no action is outstanding.',
      ],
    },
    candidates: [
      { candidate_id: 'c_wait', operation: 'thread.wait', summary: 'Wait for outstanding work to return.' },
      inspectBeta,
      assemble,
      complete,
    ],
    label: 'c_inspect_beta',
  },
];
