/** claim is identical in EpochPayout V1 and V2. Proofs/claimability come from the gateway. */
export const epochPayoutAbi = [{type:"function",name:"claim",stateMutability:"nonpayable",inputs:[{name:"epoch",type:"uint64"},{name:"amount",type:"uint256"},{name:"proof",type:"bytes32[]"}],outputs:[]}] as const;
