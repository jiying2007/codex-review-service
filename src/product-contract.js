'use strict';

const contract=Object.freeze(require('../product-contract.json'));
const SERVICE_VERSION=contract.serviceVersion;
const DATABASE_SCHEMA_VERSION=Number(contract.databaseSchemaVersion);
const CONFIG_SCHEMA_VERSION=Number(contract.configSchemaVersion);
const POLICY_SCHEMA_VERSION=Number(contract.policySchemaVersion);
const REVIEW_RECEIPT_VERSION=Number(contract.reviewReceiptVersion);
const SAFE_CONTRACT_VERSION=Number(contract.safeContractVersion);
const SAFE_CORE_COMMIT=contract.safeCoreCommit;
const MINIMUM_NODE_VERSION=contract.minimumNodeVersion;
const NODE_MAJOR_VERSION=Number(contract.nodeMajorVersion);
const MINIMUM_GITLAB_VERSION=contract.minimumGitLabVersion;

module.exports={contract,SERVICE_VERSION,DATABASE_SCHEMA_VERSION,CONFIG_SCHEMA_VERSION,POLICY_SCHEMA_VERSION,REVIEW_RECEIPT_VERSION,SAFE_CONTRACT_VERSION,SAFE_CORE_COMMIT,MINIMUM_NODE_VERSION,NODE_MAJOR_VERSION,MINIMUM_GITLAB_VERSION};
