export { MultiAgentClient, PisamaBackendError, type MultiAgentClientOptions } from './client.js';

export {
  MultiAgentDetectors,
  createMultiAgentDetectors,
  type MultiAgentDetectorsApi,
} from './detectors.js';

export type {
  ConsensusCollapseInput,
  ConsensusCollapseResult,
  CoordinationInput,
  CoordinationResult,
  DelegationInput,
  DelegationResult,
  MultiAgentDetection,
  MultiAgentSeverity,
  PersonaAgent,
  PersonaInput,
  PersonaResult,
} from './types.js';
