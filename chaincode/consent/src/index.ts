import { ConsentContract } from './consentContract';

export { ConsentContract } from './consentContract';
export * from './abac';

/** fabric-chaincode-node discovers the contract set through this export. */
export const contracts: unknown[] = [ConsentContract];
