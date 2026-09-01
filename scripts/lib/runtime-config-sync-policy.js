const { PROVIDER_IDS } = require("./runtime-constants.js");
const {
  pickMatchingPattern,
  pickPreferred,
  prependPreferredCandidate,
  selectCloudCandidate,
  sourceAgentCandidate,
} = require("./runtime-config-sync-helpers.js");

const MATCH_PATTERNS = Object.freeze({
  turboLocalPrimary: [
    /qwen3.*coder.*tq2/i,
    /qwen3.*coder.*tq1/i,
    /qwen.*coder.*tq/i,
    /coder.*tq2/i,
    /coder.*tq1/i,
    /qwen3.*coder/i,
    /qwen.*coder/i,
    /coder/i,
  ],
  turboLocalSmall: [
    /ministral.*tq2/i,
    /mistral.*tq2/i,
    /qwen2\.5.*coder.*tq2/i,
    /tq2/i,
    /ministral/i,
    /mistral/i,
    /qwen2\.5.*coder/i,
  ],
  turboLocalReasoning: [
    /qwen3\.5.*tq2/i,
    /qwq.*tq2/i,
    /gpt-oss.*tq2/i,
    /nemotron.*tq2/i,
    /tq2/i,
    /qwen3\.5/i,
    /qwq/i,
    /gpt-oss/i,
    /nemotron/i,
  ],
  turboRemotePlanning: [
    /qwen3\.5.*tq2/i,
    /qwq.*tq2/i,
    /gpt-oss.*tq2/i,
    /nemotron.*tq2/i,
    /qwen3.*coder.*tq2/i,
    /tq2/i,
    /qwen3\.5/i,
    /qwq/i,
    /gpt-oss/i,
    /nemotron/i,
    /qwen3.*coder/i,
  ],
  turboRemoteReasoning: [
    /qwq.*tq2/i,
    /qwen3\.5.*tq2/i,
    /gpt-oss.*tq2/i,
    /nemotron.*tq2/i,
    /tq2/i,
    /qwq/i,
    /qwen3\.5/i,
    /gpt-oss/i,
    /nemotron/i,
  ],
  turboRemoteCoding: [
    /qwen3.*coder.*tq2/i,
    /qwen3.*coder.*tq1/i,
    /qwen.*coder.*tq/i,
    /coder.*tq2/i,
    /coder.*tq1/i,
    /qwen3.*coder/i,
    /qwen.*coder/i,
    /coder/i,
  ],
});

const PREFERRED_MODELS = Object.freeze({
  localPrimary: [
    "qwen3.5:27b-q8_0",
    "qwen3-coder:30b-a3b-q8_0",
    "qwen3.5:27b",
    "nemotron-cascade-2:30b",
    "qwq:32b-q8_0",
    "ministral-3:14b",
    "qwen2.5:7b",
  ],
  localSmall: [
    "ministral-3:14b",
    "qwen2.5:7b",
    "llama3.1:8b",
    "qwen3.5:27b",
    "nemotron-cascade-2:30b",
  ],
  localReasoning: [
    "qwen3.5:27b-bf16",
    "qwen3.5:27b-q8_0",
    "qwq:32b-q8_0",
    "nemotron-cascade-2:30b",
    "qwen3-coder:30b-a3b-fp16",
    "qwen3-coder:30b-a3b-q8_0",
    "qwen3-coder:30b",
  ],
  remotePlanning: [
    "qwen3.5:35b",
    "qwq:32b",
    "nemotron-cascade-2:latest",
    "gpt-oss:20b",
    "qwen3-coder:30b",
    "qwen2.5-coder:32b",
    "qwen2.5-coder:14b",
    "qwen2.5-coder:7b",
    "codegemma:7b",
  ],
  remoteReasoning: [
    "qwq:32b",
    "nemotron-cascade-2:latest",
    "gpt-oss:20b",
    "qwen3.5:35b",
    "qwen3-coder:30b",
    "qwen2.5-coder:32b",
    "qwen2.5-coder:14b",
    "qwen2.5-coder:7b",
    "codegemma:7b",
  ],
  remoteFast: [
    "gpt-oss:20b",
    "qwen2.5-coder:7b",
    "codegemma:7b",
    "qwen2.5-coder:14b",
    "qwen3-coder:30b",
  ],
  remoteCoding: ["qwen3-coder:30b", "qwen2.5-coder:32b", "qwen2.5-coder:14b", "qwen2.5-coder:7b"],
  remote5090Reasoning: [
    "qwen3.5:27b-q8_0",
    "qwen3.5:27b",
    "qwq:32b-q8_0",
    "nemotron-cascade-2:30b",
    "qwen3-coder:30b-a3b-q8_0",
  ],
  remote5090Coding: [
    "qwen3-coder:30b-a3b-q8_0",
    "qwen3-coder:30b",
    "qwen2.5-coder:32b",
    "qwen2.5-coder:14b",
    "qwen2.5-coder:7b",
  ],
  cloudPlanning: {
    preferredNames: ["gemini-2.5-pro", "gemini-2.0-pro", "gpt-5", "gpt-4.1", "o3", "o4"],
    preferredPatterns: [
      /gemini.*(2\.5|pro)/,
      /gpt-5/,
      /gpt-4\.1/,
      /^o[34]/,
      /sonnet/,
      /opus/,
      /pro/,
    ],
  },
  cloudReasoning: {
    preferredNames: ["gemini-2.5-pro", "gpt-5", "o3", "o4"],
    preferredPatterns: [/gemini.*(2\.5|pro)/, /gpt-5/, /^o[34]/, /reason/, /sonnet/, /opus/, /pro/],
  },
  cloudFast: {
    preferredNames: ["gemini-2.0-flash", "gemini-1.5-flash", "gpt-4.1-mini", "gpt-4o-mini"],
    preferredPatterns: [/haiku/, /flash/, /mini/, /turbo/],
  },
  cloudCoding: {
    preferredNames: ["gpt-5", "gpt-4.1", "gemini-2.5-pro"],
    preferredPatterns: [/code/, /coder/, /gpt/, /gemini/, /sonnet/, /pro/],
  },
});

function buildSyncPolicy({
  cloudProviders,
  config,
  localNames,
  openAiLocalUsableNames,
  openAiRemoteUsableNames,
  remote5090UsableNames,
  remoteUsableNames,
  source,
}) {
  const turboLocalPrimary = pickMatchingPattern(
    openAiLocalUsableNames,
    MATCH_PATTERNS.turboLocalPrimary,
    openAiLocalUsableNames[0] || null
  );
  const turboLocalSmall = pickMatchingPattern(
    openAiLocalUsableNames,
    MATCH_PATTERNS.turboLocalSmall,
    turboLocalPrimary
  );
  const turboLocalReasoning = pickMatchingPattern(
    openAiLocalUsableNames,
    MATCH_PATTERNS.turboLocalReasoning,
    turboLocalPrimary
  );
  const turboRemotePlanning = pickMatchingPattern(
    openAiRemoteUsableNames,
    MATCH_PATTERNS.turboRemotePlanning,
    openAiRemoteUsableNames[0] || null
  );
  const turboRemoteReasoning = pickMatchingPattern(
    openAiRemoteUsableNames,
    MATCH_PATTERNS.turboRemoteReasoning,
    turboRemotePlanning
  );
  const turboRemoteCoding = pickMatchingPattern(
    openAiRemoteUsableNames,
    MATCH_PATTERNS.turboRemoteCoding,
    turboRemotePlanning
  );

  const localPrimary = pickPreferred(
    localNames,
    PREFERRED_MODELS.localPrimary,
    config.model?.startsWith(`${PROVIDER_IDS.ollamaLocal}/`)
      ? config.model.slice(PROVIDER_IDS.ollamaLocal.length + 1)
      : null
  );
  const localSmall = pickPreferred(localNames, PREFERRED_MODELS.localSmall, localPrimary);
  const preferCopilotLocal =
    config.model?.startsWith("github-copilot/") ||
    config.small_model?.startsWith("github-copilot/");
  const localReasoning = pickPreferred(localNames, PREFERRED_MODELS.localReasoning, localPrimary);
  const remotePlanning = pickPreferred(
    remoteUsableNames,
    PREFERRED_MODELS.remotePlanning,
    remoteUsableNames[0] || null
  );
  const remoteReasoning = pickPreferred(
    remoteUsableNames,
    PREFERRED_MODELS.remoteReasoning,
    remotePlanning
  );
  const remoteFast = pickPreferred(remoteUsableNames, PREFERRED_MODELS.remoteFast, remotePlanning);
  const remoteCoding = pickPreferred(
    remoteUsableNames,
    PREFERRED_MODELS.remoteCoding,
    remotePlanning
  );
  const remote5090Reasoning = pickPreferred(
    remote5090UsableNames,
    PREFERRED_MODELS.remote5090Reasoning,
    remoteReasoning
  );
  const remote5090Coding = pickPreferred(
    remote5090UsableNames,
    PREFERRED_MODELS.remote5090Coding,
    remoteCoding
  );
  const cloudPlanning = selectCloudCandidate(
    cloudProviders,
    PREFERRED_MODELS.cloudPlanning.preferredNames,
    PREFERRED_MODELS.cloudPlanning.preferredPatterns
  );
  const cloudReasoning = selectCloudCandidate(
    cloudProviders,
    PREFERRED_MODELS.cloudReasoning.preferredNames,
    PREFERRED_MODELS.cloudReasoning.preferredPatterns
  );
  const cloudFast = selectCloudCandidate(
    cloudProviders,
    PREFERRED_MODELS.cloudFast.preferredNames,
    PREFERRED_MODELS.cloudFast.preferredPatterns
  );
  const cloudCoding = selectCloudCandidate(
    cloudProviders,
    PREFERRED_MODELS.cloudCoding.preferredNames,
    PREFERRED_MODELS.cloudCoding.preferredPatterns
  );

  const codingCandidates = [
    { providerId: PROVIDER_IDS.sglangRemote, model: turboRemoteCoding },
    { providerId: PROVIDER_IDS.llamaCppLocal, model: turboLocalPrimary },
    { providerId: PROVIDER_IDS.ollamaRemote, model: remoteCoding || remote5090Coding },
    { providerId: PROVIDER_IDS.ollamaLocal, model: localPrimary },
  ];
  const reasoningCandidates = [
    { providerId: PROVIDER_IDS.sglangRemote, model: turboRemoteReasoning },
    { providerId: PROVIDER_IDS.llamaCppLocal, model: turboLocalReasoning },
    { providerId: PROVIDER_IDS.ollamaRemote, model: remoteReasoning || remote5090Reasoning },
    { providerId: PROVIDER_IDS.ollamaLocal, model: localReasoning },
  ];
  const reasoningCandidatesWithout5090Priority = [
    { providerId: PROVIDER_IDS.sglangRemote, model: turboRemoteReasoning },
    { providerId: PROVIDER_IDS.llamaCppLocal, model: turboLocalReasoning },
    { providerId: PROVIDER_IDS.ollamaRemote, model: remoteReasoning || remote5090Reasoning },
    { providerId: PROVIDER_IDS.ollamaLocal, model: localReasoning },
  ];
  const planningCandidates = [
    { providerId: PROVIDER_IDS.sglangRemote, model: turboRemotePlanning },
    { providerId: PROVIDER_IDS.llamaCppLocal, model: turboLocalReasoning },
    { providerId: PROVIDER_IDS.ollamaRemote, model: remotePlanning },
    { providerId: PROVIDER_IDS.ollamaLocal, model: localReasoning },
    cloudPlanning,
  ];
  const executionCandidates = [
    { providerId: PROVIDER_IDS.llamaCppLocal, model: turboLocalReasoning },
    { providerId: PROVIDER_IDS.sglangRemote, model: turboRemotePlanning },
    { providerId: PROVIDER_IDS.ollamaRemote, model: remotePlanning },
    { providerId: PROVIDER_IDS.ollamaRemote, model: remoteReasoning },
    { providerId: PROVIDER_IDS.ollamaLocal, model: localReasoning },
    { providerId: PROVIDER_IDS.ollamaLocal, model: localPrimary },
    { providerId: PROVIDER_IDS.ollamaLocal, model: localSmall },
    cloudPlanning,
  ];

  const withSourceAgentPreference = (agentName, candidates) =>
    prependPreferredCandidate(candidates, sourceAgentCandidate(source, agentName));

  const ifUnavailableAssignments = preferCopilotLocal
    ? []
    : [
        [
          "build",
          withSourceAgentPreference("build", [
            { providerId: PROVIDER_IDS.sglangRemote, model: turboRemoteCoding },
            { providerId: PROVIDER_IDS.llamaCppLocal, model: turboLocalPrimary },
            { providerId: PROVIDER_IDS.ollamaRemote, model: remoteCoding },
            { providerId: PROVIDER_IDS.ollamaLocal, model: localPrimary },
          ]),
        ],
        [
          "fast-build",
          withSourceAgentPreference("fast-build", [
            { providerId: PROVIDER_IDS.llamaCppLocal, model: turboLocalPrimary || turboLocalSmall },
            { providerId: PROVIDER_IDS.sglangRemote, model: turboRemoteCoding },
            ...codingCandidates.slice(2),
          ]),
        ],
        ["reviewer", withSourceAgentPreference("reviewer", reasoningCandidates)],
        ["qa-lead", withSourceAgentPreference("qa-lead", reasoningCandidatesWithout5090Priority)],
        ["release-manager", withSourceAgentPreference("release-manager", reasoningCandidates)],
        ["rust-rewrite", withSourceAgentPreference("rust-rewrite", codingCandidates)],
        ["model-trainer", withSourceAgentPreference("model-trainer", codingCandidates)],
      ];

  return {
    defaultModels: preferCopilotLocal
      ? null
      : {
          providerId: turboLocalPrimary ? PROVIDER_IDS.llamaCppLocal : PROVIDER_IDS.ollamaLocal,
          model: turboLocalPrimary || localPrimary,
          smallProviderId: turboLocalSmall
            ? PROVIDER_IDS.llamaCppLocal
            : turboLocalPrimary
              ? PROVIDER_IDS.llamaCppLocal
              : PROVIDER_IDS.ollamaLocal,
          smallModel: turboLocalSmall || localSmall || turboLocalPrimary || localPrimary,
        },
    ifUnavailableAssignments,
    controllerAssignments: [
      {
        agentName: "plan",
        preserveCopilot: true,
        candidates: withSourceAgentPreference("plan", [
          { providerId: PROVIDER_IDS.llamaCppLocal, model: turboLocalReasoning },
          ...planningCandidates,
        ]),
      },
      {
        agentName: "architect",
        preserveCopilot: false,
        candidates: withSourceAgentPreference("architect", planningCandidates),
      },
      {
        agentName: "execution-orchestrator",
        preserveCopilot: true,
        candidates: withSourceAgentPreference("execution-orchestrator", executionCandidates),
      },
      {
        agentName: "parallel-execution-orchestrator",
        preserveCopilot: true,
        candidates: withSourceAgentPreference("parallel-execution-orchestrator", [
          {
            providerId: PROVIDER_IDS.llamaCppLocal,
            model: turboLocalPrimary || turboLocalReasoning,
          },
          ...executionCandidates.slice(1),
        ]),
      },
    ],
    alwaysAssignments: [
      [
        "incident-commander",
        withSourceAgentPreference("incident-commander", [
          { providerId: PROVIDER_IDS.sglangRemote, model: turboRemoteReasoning },
          { providerId: PROVIDER_IDS.llamaCppLocal, model: turboLocalReasoning },
          { providerId: PROVIDER_IDS.ollamaRemote, model: remoteReasoning },
          { providerId: PROVIDER_IDS.ollamaLocal, model: localReasoning },
          cloudReasoning,
        ]),
      ],
      [
        "research",
        withSourceAgentPreference("research", [
          { providerId: PROVIDER_IDS.sglangRemote, model: turboRemoteReasoning },
          { providerId: PROVIDER_IDS.llamaCppLocal, model: turboLocalReasoning },
          { providerId: PROVIDER_IDS.ollamaRemote, model: remoteReasoning },
          { providerId: PROVIDER_IDS.ollamaLocal, model: localReasoning },
          cloudReasoning,
        ]),
      ],
      [
        "reasoning-fast",
        withSourceAgentPreference("reasoning-fast", [
          { providerId: PROVIDER_IDS.llamaCppLocal, model: turboLocalSmall || turboLocalPrimary },
          { providerId: PROVIDER_IDS.sglangRemote, model: turboRemoteReasoning },
          { providerId: PROVIDER_IDS.ollamaRemote, model: remoteFast },
          { providerId: PROVIDER_IDS.ollamaLocal, model: localSmall || localPrimary },
          cloudFast,
        ]),
      ],
      [
        "performance-engineer",
        withSourceAgentPreference("performance-engineer", [
          { providerId: PROVIDER_IDS.sglangRemote, model: turboRemoteCoding },
          { providerId: PROVIDER_IDS.llamaCppLocal, model: turboLocalPrimary },
          { providerId: PROVIDER_IDS.ollamaRemote, model: remoteCoding },
          { providerId: PROVIDER_IDS.ollamaLocal, model: localPrimary },
          cloudCoding,
        ]),
      ],
      [
        "deep-thinker",
        withSourceAgentPreference("deep-thinker", [
          { providerId: PROVIDER_IDS.sglangRemote, model: turboRemoteReasoning },
          { providerId: PROVIDER_IDS.llamaCppLocal, model: turboLocalReasoning },
          { providerId: PROVIDER_IDS.ollamaRemote, model: remoteReasoning },
          { providerId: PROVIDER_IDS.ollamaLocal, model: localReasoning },
          cloudReasoning,
        ]),
      ],
    ],
  };
}

module.exports = {
  buildSyncPolicy,
};
