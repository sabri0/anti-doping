// Shared mocha setup: promise-aware assertions for chaincode rejection paths.
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

chai.use(chaiAsPromised);
