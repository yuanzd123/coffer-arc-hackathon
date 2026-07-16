// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Minimal, non-custodial attestation surface for Coffer decisions.
/// @dev Business policy evaluation remains offchain. This contract stores only
///      an opaque commitment and its final outcome; it cannot hold or move funds.
contract CofferDecisionRegistry {
    enum DecisionOutcome {
        Blocked,
        RequiresApproval,
        Approved
    }

    struct AnchoredDecision {
        bool exists;
        DecisionOutcome outcome;
        uint64 anchoredAtBlock;
    }

    error Unauthorized();
    error InvalidOperator();
    error InvalidCommitment();
    error ConflictingDecision();

    address public immutable operator;
    mapping(bytes32 commitment => AnchoredDecision decision) private decisions;

    event DecisionAnchored(
        bytes32 indexed commitment,
        DecisionOutcome indexed outcome,
        address indexed operator,
        uint64 anchoredAtBlock
    );

    constructor(address authorizedOperator) {
        if (authorizedOperator == address(0)) revert InvalidOperator();
        operator = authorizedOperator;
    }

    function anchorDecision(bytes32 commitment, DecisionOutcome outcome) external {
        if (msg.sender != operator) revert Unauthorized();
        if (commitment == bytes32(0)) revert InvalidCommitment();

        AnchoredDecision memory existing = decisions[commitment];
        if (existing.exists) {
            if (existing.outcome != outcome) revert ConflictingDecision();
            return;
        }

        uint64 anchoredAtBlock = uint64(block.number);
        decisions[commitment] = AnchoredDecision({
            exists: true,
            outcome: outcome,
            anchoredAtBlock: anchoredAtBlock
        });
        emit DecisionAnchored(commitment, outcome, msg.sender, anchoredAtBlock);
    }

    function getDecision(bytes32 commitment) external view returns (AnchoredDecision memory) {
        return decisions[commitment];
    }
}
