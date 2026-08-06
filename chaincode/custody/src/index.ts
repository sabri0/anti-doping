import { CustodyContract } from './custodyContract';

export { CustodyContract } from './custodyContract';
export * from './resultsDecision';
export * from './types';

/** fabric-chaincode-node discovers the contract set through this export. */
export const contracts: unknown[] = [CustodyContract];
